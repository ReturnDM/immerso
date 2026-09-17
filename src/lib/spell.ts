// 拼写纠错：Damerau-Levenshtein 距离（含相邻换位）。
// 纯函数、零依赖，node 可直测（scripts/ 下模拟/测试直接 import）。

/**
 * a→b 的编辑距离（增/删/改/相邻换位）。
 * recieve→receive = 1（换位）、recived→receive = 2（缺 e、多 d…按实际算）。
 * 长度差超过 2 时直接返回长度差（真实距离 ≥ 长度差，调用方阈值 ≤2 即可据此剪枝）。
 */
export function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return Math.abs(la - lb);
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}
