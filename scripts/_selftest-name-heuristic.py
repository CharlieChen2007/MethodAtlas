"""自测 verify-local 里那个「名字像不像被截断的英文句子」的启发式。

为什么单独写一个：
  这个判定同时在两处用（画布取到的名字 + DB 直查的名字），
  而且它的例外规则改过好几轮（全角括号、缩写前后缀…）。
  换语料时先跑这个，能在跑整套 15 分钟回归之前就知道启发式对不对。

用法：python scripts/_selftest-name-heuristic.py
"""
import re
import sqlite3
from pathlib import Path

ROOT = Path(r"C:\Users\Charlie\Desktop\METHODATLAS\MethodAtlas\methodatlas")


def looks_like_truncated_sentence(n):
    """与 verify-local.py 中 _looks_like_truncated_sentence 保持一致的副本。"""
    t = (n or "").strip()
    if not t:
        return True
    if t.endswith("...") or t.endswith("…"):
        return True
    if re.search(
        r"\b(?:and|or|the|a|an|of|for|in|on|to|with|by|from|as|that|which|we|is|are|was|were)$",
        t, re.I,
    ):
        return True
    if re.match(
        r"^(?:we|our|this|these|those|it|they|however|additionally|moreover|in|but|and|used|encoded|consider|introduce|design|evaluate|combine|providing|generative)\b",
        t, re.I,
    ):
        if "(" not in t:
            return True
        if re.search(r"\((?:[A-Z][A-Za-z0-9-]{1,11}|[A-Za-z]+(?:-[A-Za-z]+)+)\)\s*$", t):
            return False
    if re.search(r"\b(?:which|that|where|who|achieve|outperform|concatenates|investigate)\b", t, re.I):
        if "(" not in t:
            return True
    if len(t) > 30:
        if re.match(r"^[A-Za-z0-9-]{2,8}\s*\(", t):
            return False
        if "（" in t and "）" in t:
            return False
        if re.search(r"\([A-Za-z0-9][A-Za-z0-9-]{1,11}\)\s*$", t):
            return False
        if re.search(r"[\u4e00-\u9fff]", t) and "(" in t and ")" in t:
            return False
        return True
    return False


def main():
    # ① 先验必判可疑的（真截断句）
    must_flag = [
        "We propose a method that uses the",
        "encoded by a transformer and then",
        "提供了一种新的方法…",
        "Spatial WiFi Signal Modeling (MGPR) and",
    ]
    # ② 再验必判合格的（合法模块名，含换语料后新出现的形态）
    must_pass = [
        "Virtual Reference Point Generation (VRPG)",
        "Spatial WiFi Signal Modeling (MGPR)",
        "混合核函数 (Matern + Rational Quadratic)",
        "混合核函数（Matern + Rational Quadratic）",
        "GAN (Generative Adversarial Network)",
        "TriReg 三网回归器",
        "前向加噪过程",
        "CNN 定位模型",
        "Localization System (BOML-Loc)",
    ]
    bad = []
    for s in must_flag:
        if not looks_like_truncated_sentence(s):
            bad.append(f"应当可疑但被判合格：{s!r}")
    for s in must_pass:
        if looks_like_truncated_sentence(s):
            bad.append(f"应当合格但被判可疑：{s!r}")

    print("规则自测：")
    for s in must_flag:
        print(f"  可疑? {looks_like_truncated_sentence(s)!s:5}  {s!r}")
    print()
    for s in must_pass:
        print(f"  可疑? {looks_like_truncated_sentence(s)!s:5}  {s!r}")

    # ③ 再用库里真实数据跑一遍
    db = ROOT / "prisma" / "dev.db"
    if db.exists():
        con = sqlite3.connect(str(db))
        names = [r[0] for r in con.execute("SELECT name FROM MethodBlock").fetchall()]
        con.close()
        flagged = [n for n in names if looks_like_truncated_sentence(n)]
        print(f"\n库内真实 Block 名：共 {len(names)} 个，仍被判可疑 {len(flagged)} 个")
        for n in flagged[:8]:
            print(f"    {n}")

    print()
    if bad:
        print("❌ 自测失败：")
        for b in bad:
            print("   " + b)
        raise SystemExit(1)
    print("✅ 自测通过（真截断句全被判可疑，合法模块名全被放行）")


if __name__ == "__main__":
    main()
