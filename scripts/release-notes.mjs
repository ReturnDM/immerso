// 发布流水线用：从 CHANGELOG.md 提取当前标签对应版本的段落写入 GITHUB_OUTPUT
import fs from "node:fs";

const tag = process.env.GITHUB_REF_NAME;
if (!tag || !/^v\d/.test(tag)) {
  console.error(`非法标签：${tag}`);
  process.exit(1);
}

const lines = fs.readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## ${tag} `) || l.trim() === `## ${tag}`);
if (start === -1) {
  console.error(`CHANGELOG.md 里找不到 ${tag} 的段落，发版前先补一段`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}

const body = [
  lines.slice(start + 1, end).join("\n").trim(),
  "",
  "---",
  "Windows 下载 `-setup.exe` 安装；macOS 下载 `.dmg`（通用二进制，未签名：右键 → 打开，或执行 `xattr -cr \"/Applications/immerso.app\"`）。",
].join("\n");

// 多行输出写进 GITHUB_OUTPUT（heredoc 语法），release.yml 里用 steps.notes.outputs.body 引用
const out = process.env.GITHUB_OUTPUT;
if (out) fs.appendFileSync(out, `body<<NOTES_EOF\n${body}\nNOTES_EOF\n`);
fs.writeFileSync("release_body.md", body);
console.log(`已提取 ${tag} 版本说明，共 ${body.length} 字符`);
