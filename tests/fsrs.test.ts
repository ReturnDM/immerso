import { describe, it, expect } from "vitest";
import {
  GRADES,
  GRADE_META,
  toCard,
  previewOptions,
  schedule,
  intervalText,
  stateLabel,
} from "../src/lib/fsrs";
import {
  createEmptyCard,
  Rating,
  State,
  type Card,
} from "ts-fsrs";

/** 构造一张"复习中"的卡（模仿真实已学卡的学习参数） */
function makeReviewCard(): Card {
  const now = new Date();
  return {
    due: new Date(now.getTime() + 86_400_000), // 明天到期
    stability: 5,
    difficulty: 4,
    elapsed_days: 1,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 8,
    lapses: 0,
    state: State.Review,
    last_review: now,
  };
}

describe("fsrs GRADES / GRADE_META", () => {
  it("GRADES 为四档 1..4", () => {
    expect(GRADES).toEqual([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
  });

  it("GRADE_META 覆盖全部档位：忘记/困难/良好/简单 + 快捷键 1..4", () => {
    expect(GRADE_META[1].label).toBe("忘记");
    expect(GRADE_META[2].label).toBe("困难");
    expect(GRADE_META[3].label).toBe("良好");
    expect(GRADE_META[4].label).toBe("简单");
    expect(GRADE_META[1].key).toBe("1");
    expect(GRADE_META[4].key).toBe("4");
    expect(GRADE_META[1].cls).toContain("rose");
  });
});

describe("toCard（DB 行 → ts-fsrs Card）", () => {
  it("新卡（state=0）直接返回 createEmptyCard", () => {
    const card = toCard({
      state: State.New,
      stability: 0,
      difficulty: 0,
      due: null,
      last_review: null,
      reps: 0,
      lapses: 0,
    });
    expect(card.state).toBe(State.New);
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.stability).toBe(0);
  });

  it("复习卡：正确换算 elapsed_days / scheduled_days", () => {
    const now = new Date();
    const last = new Date(now.getTime() - 3 * 86_400_000); // 3 天前
    const due = new Date(now.getTime() + 2 * 86_400_000); // 2 天后
    const card = toCard({
      state: State.Review,
      stability: 7.5,
      difficulty: 3.2,
      due: due.toISOString(),
      last_review: last.toISOString(),
      reps: 12,
      lapses: 1,
    });
    expect(card.state).toBe(State.Review);
    expect(card.stability).toBe(7.5);
    expect(card.difficulty).toBe(3.2);
    expect(card.reps).toBe(12);
    expect(card.lapses).toBe(1);
    // elapsed_days = floor((now - last)/1天)；刚构造应 = 3（毫秒级误差向下取整为 3）
    expect(card.elapsed_days).toBe(3);
    // scheduled_days = round((due - last)/1天) = 5
    expect(card.scheduled_days).toBe(5);
    expect(card.last_review?.getTime()).toBe(last.getTime());
  });

  it("last_review 为空时 elapsed/scheduled 归零且不设 last_review", () => {
    const card = toCard({
      state: State.Review,
      stability: 1,
      difficulty: 1,
      due: new Date(Date.now() + 86_400_000).toISOString(),
      last_review: null,
      reps: 3,
      lapses: 0,
    });
    expect(card.elapsed_days).toBe(0);
    expect(card.scheduled_days).toBe(0);
    expect(card.last_review).toBeUndefined();
  });

  it("学习中的卡保留状态", () => {
    const card = toCard({
      state: State.Learning,
      stability: 1.5,
      difficulty: 5,
      due: new Date(Date.now() + 600_000).toISOString(),
      last_review: new Date().toISOString(),
      reps: 1,
      lapses: 0,
    });
    expect(card.state).toBe(State.Learning);
  });
});

describe("新卡首次评分 -> 状态与间隔", () => {
  it("Again -> Learning，间隔 ≤ 2 分钟（学习步骤 1m）", () => {
    const now = new Date();
    const r = schedule(createEmptyCard(), Rating.Again);
    expect(r.card.state).toBe(State.Learning);
    const diff = r.card.due.getTime() - now.getTime();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(2 * 60_000);
  });

  it("Easy -> 直接毕业为 Review，间隔数天", () => {
    const now = new Date();
    const r = schedule(createEmptyCard(), Rating.Easy);
    expect(r.card.state).toBe(State.Review);
    const days = (r.card.due.getTime() - now.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(3); // 默认权重下首评 Easy 约 8 天
  });

  it("新卡梯度：Easy 的到期时间 > Good > Hard > Again（同一快照比较）", () => {
    const now = new Date();
    const rec = previewOptions(createEmptyCard()).scheduling;
    const due = (g: Rating) => rec[g].card.due.getTime();
    expect(due(Rating.Easy)).toBeGreaterThan(due(Rating.Good));
    expect(due(Rating.Good)).toBeGreaterThan(due(Rating.Hard));
    expect(due(Rating.Hard)).toBeGreaterThan(due(Rating.Again));
  });

  it("学习链：Again -> Good -> Good 最终进入 Review 且间隔拉长", () => {
    let card = createEmptyCard();
    card = schedule(card, Rating.Again).card; // Learning 1m
    expect(card.state).toBe(State.Learning);
    card = schedule(card, Rating.Good).card; // 学习步骤推进
    card = schedule(card, Rating.Good).card; // 完成学习
    expect(card.state).toBe(State.Review);
  });
});

describe("复习卡评分 -> 状态转移", () => {
  it("Again -> Relearning（忘记回到重学）", () => {
    const r = schedule(makeReviewCard(), Rating.Again);
    expect(r.card.state).toBe(State.Relearning);
  });

  it("Hard/Good/Easy -> 保持 Review", () => {
    for (const g of [Rating.Hard, Rating.Good, Rating.Easy]) {
      const r = schedule(makeReviewCard(), g);
      expect(r.card.state).toBe(State.Review);
    }
  });

  it("Easy 的间隔 > Good > Hard > Again（同批次 preview）", () => {
    const rec = previewOptions(makeReviewCard()).scheduling;
    const due = (g: Rating) => rec[g].card.due.getTime();
    // Again 应最近（重学）
    expect(due(Rating.Again)).toBeLessThan(due(Rating.Hard));
    expect(due(Rating.Hard)).toBeLessThan(due(Rating.Good));
    expect(due(Rating.Good)).toBeLessThan(due(Rating.Easy));
  });

  it("重复 Good 后卡仍在复习且 stability 不降为 0", () => {
    let card = makeReviewCard();
    for (let i = 0; i < 4; i++) {
      card = schedule(card, Rating.Good).card;
      expect(card.state).toBe(State.Review);
      expect(card.stability).toBeGreaterThan(0);
      expect(card.difficulty).toBeGreaterThanOrEqual(1);
      expect(card.difficulty).toBeLessThanOrEqual(10);
    }
  });

  it("limits：重复复习卡 reps/lapses 会随调度变化（Again 增加 lapses）", () => {
    const before = makeReviewCard();
    const r = schedule(before, Rating.Again);
    expect(r.card.lapses).toBeGreaterThanOrEqual(before.lapses + 1);
    expect(r.card.reps).toBeGreaterThan(before.reps);
  });
});

describe("previewOptions（四档预览）", () => {
  it("返回 4 个选项且文本非空、与评分一一对应", () => {
    const { options, scheduling } = previewOptions(createEmptyCard());
    expect(options).toHaveLength(4);
    expect(scheduling).toBeTruthy();
    for (const o of options) {
      expect(o.text.length).toBeGreaterThan(0);
      expect(o.grade).toBeGreaterThanOrEqual(Rating.Again);
      expect(o.grade).toBeLessThanOrEqual(Rating.Easy);
    }
    // 文本与调度结果同源性：Easy 展示的应是"天"级
    expect(options[3].text).toMatch(/天/);
  });

  it("预览的调度结果与实际评分一致（所见即所得）", () => {
    const card = makeReviewCard();
    const { scheduling } = previewOptions(card);
    // 实际采用 Good 评分
    const actual = schedule(card, Rating.Good);
    const preview = scheduling[Rating.Good];
    // due 时间应一致（毫秒级，fuzz 只在重复调用间波动，同参数同结果）
    expect(Math.abs(actual.card.due.getTime() - preview.card.due.getTime())).toBeLessThan(1000);
  });
});

describe("intervalText 边界", () => {
  it("≤ 1 分钟（含 0、负值、恰好 60s）均应显示『1 分钟内』", () => {
    expect(intervalText(0)).toBe("1 分钟内");
    expect(intervalText(-5_000)).toBe("1 分钟内");
    expect(intervalText(59_000)).toBe("1 分钟内");
    expect(intervalText(60_000)).toBe("1 分钟内");
  });

  it("分钟档", () => {
    expect(intervalText(60_001)).toBe("1 分钟");
    expect(intervalText(3_000_000)).toBe("50 分钟"); // 50 分钟
    expect(intervalText(59 * 60_000)).toBe("59 分钟");
  });

  it("小时档", () => {
    expect(intervalText(61 * 60_000)).toBe("1 小时"); // 61 分钟 -> 1 小时
    expect(intervalText(23 * 3_600_000)).toBe("23 小时");
    expect(intervalText(84_240_000)).toBe("23 小时"); // 23.4 小时
  });

  it("天档", () => {
    expect(intervalText(86_400_000)).toBe("1 天"); // 24h -> 1 天
    expect(intervalText(2 * 86_400_000)).toBe("2 天");
    expect(intervalText(30 * 86_400_000)).toBe("30 天");
  });
});

describe("stateLabel", () => {
  it("状态名映射", () => {
    expect(stateLabel(State.New)).toBe("新词");
    expect(stateLabel(State.Review)).toBe("复习");
    expect(stateLabel(State.Learning)).toBe("巩固中");
    expect(stateLabel(State.Relearning)).toBe("巩固中");
    expect(stateLabel(999 as State)).toBe("巩固中"); // 未知状态兜底
  });
});