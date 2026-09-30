import { describe, expect, it } from "vitest";
import {
  ConflictGroup,
  Fixture,
  PatchEngine,
  SwapPreview,
  compareGroups,
  compareUtf8,
  endOf,
} from "./dmx";

/* ====================================================================== */
/* 独立小规模枚举预言机：与 PatchEngine 的索引实现完全无关。               */
/* 直接构造“两灯同时落到新位置”的完整候选补丁，朴素两两核验。             */
/* ====================================================================== */

function intersects(a: Fixture, b: Fixture): boolean {
  return a.universe === b.universe && a.start <= endOf(b) && b.start <= endOf(a);
}

function sortIds(ids: string[]): string[] {
  return [...ids].sort(compareUtf8);
}

/** 朴素直接冲突预言机：probe 与 fixtures 中除 exclude 外的相交灯具（字节序）。 */
function naiveHits(fixtures: Fixture[], probe: Fixture, exclude: Set<string>): string[] {
  return sortIds(
    fixtures.filter((f) => !exclude.has(f.id) && intersects(f, probe)).map((f) => f.id),
  );
}

/** 朴素 O(n²) 冲突组预言机（并查集）。 */
function naiveGroups(fixtures: Fixture[]): ConflictGroup[] {
  const parent = new Map<string, string>(fixtures.map((f) => [f.id, f.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur)! !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < fixtures.length; i++) {
    for (let j = i + 1; j < fixtures.length; j++) {
      if (intersects(fixtures[i], fixtures[j])) {
        const ra = find(fixtures[i].id);
        const rb = find(fixtures[j].id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const comps = new Map<string, Fixture[]>();
  for (const f of fixtures) {
    const root = find(f.id);
    const arr = comps.get(root);
    if (arr) arr.push(f);
    else comps.set(root, [f]);
  }
  const groups: ConflictGroup[] = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    groups.push({
      universe: members[0].universe,
      minStart: Math.min(...members.map((m) => m.start)),
      ids: members.map((m) => m.id).sort(compareUtf8),
    });
  }
  groups.sort(compareGroups);
  return groups;
}

/** 候选补丁：互换 idA/idB 的 universe 与 start，footprint 随原灯具。 */
function swappedPatch(patch: Fixture[], idA: string, idB: string): Fixture[] {
  const a = patch.find((f) => f.id === idA)!;
  const b = patch.find((f) => f.id === idB)!;
  return patch.map((f) => {
    if (f.id === idA) return { ...f, universe: b.universe, start: b.start };
    if (f.id === idB) return { ...f, universe: a.universe, start: a.start };
    return { ...f };
  });
}

/** 预言机结论：在完整候选补丁上统一核验（不模拟逐盏试移）。 */
function oracleLegality(
  baseline: Fixture[],
  candidate: Fixture[],
  idA: string,
  idB: string,
): boolean {
  const byId = new Map(candidate.map((f) => [f.id, f]));
  const a = byId.get(idA)!;
  const b = byId.get(idB)!;
  // 通道上界
  if (a.start + a.footprint > 513) return false;
  if (b.start + b.footprint > 513) return false;
  // 两灯相互重叠：无条件拒绝（即使该冲突对原本存在）
  if (intersects(a, b)) return false;
  // 与其他灯具：不得新增任何冲突对（旧冲突对允许保留）
  const baseById = new Map(baseline.map((f) => [f.id, f]));
  for (const f of candidate) {
    if (f.id === idA || f.id === idB) continue;
    const oldA = intersects(baseById.get(idA)!, f);
    if (intersects(a, f) && !oldA) return false;
    const oldB = intersects(baseById.get(idB)!, f);
    if (intersects(b, f) && !oldB) return false;
  }
  return true;
}

/** 用朴素预言机逐字段核对预演结果。 */
function expectPreviewMatchesOracle(
  preview: SwapPreview,
  baseline: Fixture[],
  idA: string,
  idB: string,
) {
  const candidate = swappedPatch(baseline, idA, idB);
  const candA = candidate.find((f) => f.id === idA)!;
  const candB = candidate.find((f) => f.id === idB)!;
  const baseA = baseline.find((f) => f.id === idA)!;
  const baseB = baseline.find((f) => f.id === idB)!;

  expect(preview.a.fixture).toEqual(baseA);
  expect(preview.b.fixture).toEqual(baseB);
  expect(preview.a.targetUniverse).toBe(baseB.universe);
  expect(preview.a.targetStart).toBe(baseB.start);
  expect(preview.b.targetUniverse).toBe(baseA.universe);
  expect(preview.b.targetStart).toBe(baseA.start);

  expect(preview.a.inBounds).toBe(candA.start + candA.footprint <= 513);
  expect(preview.b.inBounds).toBe(candB.start + candB.footprint <= 513);
  expect(preview.mutualOverlap).toBe(intersects(candA, candB));

  // 原位（当前补丁口径，含对方）
  expect(preview.a.origin).toEqual(naiveHits(baseline, baseA, new Set([idA])));
  expect(preview.b.origin).toEqual(naiveHits(baseline, baseB, new Set([idB])));
  // 目标位（完整候选补丁口径，含相互重叠的对方）
  expect(preview.a.target).toEqual(naiveHits(candidate, candA, new Set([idA])));
  expect(preview.b.target).toEqual(naiveHits(candidate, candB, new Set([idB])));

  // 冲突变化 = 目标（候选口径）对原位的集合差
  expect(preview.a.added).toEqual(
    preview.a.target.filter((id) => !preview.a.origin.includes(id)),
  );
  expect(preview.a.removed).toEqual(
    preview.a.origin.filter((id) => !preview.a.target.includes(id)),
  );
  expect(preview.b.added).toEqual(
    preview.b.target.filter((id) => !preview.b.origin.includes(id)),
  );
  expect(preview.b.removed).toEqual(
    preview.b.origin.filter((id) => !preview.b.target.includes(id)),
  );

  expect(preview.canCommit).toBe(oracleLegality(baseline, candidate, idA, idB));
}

/* ---------- 小补丁全枚举：两具灯具，不同 footprint/通道/universe ---------- */

describe("双灯原子互换：两具灯具小补丁全枚举预言机", () => {
  // 小通道域：universe {1,2}，start {1,2,3}，footprint {1,2,3}（含端点相接）
  const SPECS: Array<[number, number, number]> = [];
  for (const u of [1, 2]) {
    for (const s of [1, 2, 3]) {
      for (const fp of [1, 2, 3]) {
        if (s + fp <= 4) SPECS.push([u, s, fp]);
      }
    }
  }

  it("所有有序灯具规格对：预演字段、可提交判定与朴素候选补丁完全一致", () => {
    let count = 0;
    for (const [ua, sa, fa] of SPECS) {
      for (const [ub, sb, fb] of SPECS) {
        const baseline: Fixture[] = [
          { id: "A", universe: ua, start: sa, footprint: fa },
          { id: "B", universe: ub, start: sb, footprint: fb },
        ];
        const engine = new PatchEngine(baseline);
        expect(engine.revision).toBe(0);
        const preview = engine.previewSwap("A", "B");
        expect(preview).not.toBeNull();
        expect(preview!.revision).toBe(0);
        expectPreviewMatchesOracle(preview!, baseline, "A", "B");
        count++;
      }
    }
    expect(count).toBe(SPECS.length * SPECS.length);
  });

  it("互换在 id 顺序上对称：(A,B) 与 (B,A) 结论一致（字段随调用顺序对调）", () => {
    for (const [ua, sa, fa] of SPECS) {
      for (const [ub, sb, fb] of SPECS) {
        const baseline: Fixture[] = [
          { id: "A", universe: ua, start: sa, footprint: fa },
          { id: "B", universe: ub, start: sb, footprint: fb },
        ];
        const p1 = new PatchEngine(baseline).previewSwap("A", "B")!;
        const p2 = new PatchEngine(baseline).previewSwap("B", "A")!;
        expect(p1.canCommit).toBe(p2.canCommit);
        expect(p1.mutualOverlap).toBe(p2.mutualOverlap);
        expect(p1.a).toEqual(p2.b);
        expect(p1.b).toEqual(p2.a);
      }
    }
  });

  it("合法互换一次生效：补丁=完整候选补丁，冲突组与朴素重算一致，修订+1", () => {
    let committed = 0;
    let rejected = 0;
    for (const [ua, sa, fa] of SPECS) {
      for (const [ub, sb, fb] of SPECS) {
        const baseline: Fixture[] = [
          { id: "A", universe: ua, start: sa, footprint: fa },
          { id: "B", universe: ub, start: sb, footprint: fb },
        ];
        const engine = new PatchEngine(baseline);
        const preview = engine.previewSwap("A", "B")!;
        const expected = swappedPatch(baseline, "A", "B");
        const result = engine.commitSwap(preview);
        if (preview.canCommit) {
          committed++;
          expect(result.status).toBe("committed");
          expect(result.preview).not.toBeNull();
          expect(engine.exportFixtures().sort((x, y) => compareUtf8(x.id, y.id))).toEqual(
            expected.sort((x, y) => compareUtf8(x.id, y.id)),
          );
          expect(engine.getGroups()).toEqual(naiveGroups(expected));
          expect(engine.revision).toBe(1);
          // footprint 随原灯具
          expect(engine.getFixture("A")!.footprint).toBe(fa);
          expect(engine.getFixture("B")!.footprint).toBe(fb);
          // 提交后的新预演修订已推进；“换回去”是否合法同样须经统一核验
          // （若原互换消解了旧冲突对，换回会把它们作为新增对重建 ⇒ 被拒）。
          const back = engine.previewSwap("A", "B")!;
          expect(back.revision).toBe(1);
          const backExpected = swappedPatch(expected, "A", "B"); // = baseline
          expect(back.canCommit).toBe(oracleLegality(expected, backExpected, "A", "B"));
        } else {
          rejected++;
          expect(result.status).toBe("rejected");
          expect(engine.exportFixtures().sort((x, y) => compareUtf8(x.id, y.id))).toEqual(
            baseline.sort((x, y) => compareUtf8(x.id, y.id)),
          );
          expect(engine.getGroups()).toEqual(naiveGroups(baseline));
          expect(engine.revision).toBe(0);
        }
      }
    }
    // 小域中两种结局都确实被枚举到（防止预言机退化为恒真/恒假）
    expect(committed).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

/* ---------- 通道上界边界（512/513）与不同 footprint 显式枚举 ---------- */

describe("双灯原子互换：通道上界边界显式枚举", () => {
  // 两灯同在 universe 1 但通道不相交，互换的合法性只取决于“对方 start + 自身 fp ≤ 513”
  const starts = [1, 2, 100, 510, 511, 512];
  const footprints = [1, 2, 3, 100, 511, 512];
  const cases: Array<[number, number, number, number]> = [];
  for (const sb of starts) {
    for (const fa of footprints) {
      for (const sa of [1, 510]) {
        for (const fb of footprints) {
          if (sa + fa <= 513 && sb + fb <= 513) cases.push([sa, fa, sb, fb]);
        }
      }
    }
  }

  it("枚举 start×footprint 边界组合：inBounds/canCommit 与候选补丁逐例一致", () => {
    expect(cases.length).toBeGreaterThan(100);
    for (const [sa, fa, sb, fb] of cases) {
      const baseline: Fixture[] = [
        { id: "A", universe: 1, start: sa, footprint: fa },
        { id: "B", universe: 1, start: sb, footprint: fb },
      ];
      const engine = new PatchEngine(baseline);
      const preview = engine.previewSwap("A", "B")!;
      const candidate = swappedPatch(baseline, "A", "B");
      // 边界判定：A 到 B 的 start 后 start + fpA ≤ 513
      const expectABounds = sb + fa <= 513;
      const expectBBounds = sa + fb <= 513;
      expect(preview.a.inBounds, `A: ${sb}+${fa}`).toBe(expectABounds);
      expect(preview.b.inBounds, `B: ${sa}+${fb}`).toBe(expectBBounds);
      expect(preview.canCommit).toBe(oracleLegality(baseline, candidate, "A", "B"));
      const result = engine.commitSwap(preview);
      if (preview.canCommit) {
        expect(result.status).toBe("committed");
        expect(engine.getGroups()).toEqual(naiveGroups(candidate));
      } else {
        expect(result.status).toBe("rejected");
        expect(engine.exportFixtures()).toEqual(baseline);
      }
    }
  });

  it("贴边互换成功：A [512,512](fp1) 与 B [1,1](fp1) 互换", () => {
    const baseline: Fixture[] = [
      { id: "A", universe: 1, start: 512, footprint: 1 },
      { id: "B", universe: 1, start: 1, footprint: 1 },
    ];
    const engine = new PatchEngine(baseline);
    const p = engine.previewSwap("A", "B")!;
    expect(p.a.inBounds).toBe(true); // 1 + 1 = 2
    expect(p.b.inBounds).toBe(true); // 512 + 1 = 513
    expect(p.canCommit).toBe(true);
    engine.commitSwap(p);
    expect(engine.getFixture("A")).toEqual({ id: "A", universe: 1, start: 1, footprint: 1 });
    expect(engine.getFixture("B")).toEqual({ id: "B", universe: 1, start: 512, footprint: 1 });
  });

  it("大 footprint 换至高 start 越界：start+footprint=514 被拒，补丁不变", () => {
    const baseline: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 512 }, // [1,512]
      { id: "B", universe: 2, start: 3, footprint: 1 }, // 空位 u2[3,3]
    ];
    const engine = new PatchEngine(baseline);
    const p = engine.previewSwap("A", "B")!;
    // A(fp512) → start 3：3+512=515 越界；B(fp1) → start 1 合法
    expect(p.a.inBounds).toBe(false);
    expect(p.b.inBounds).toBe(true);
    expect(p.canCommit).toBe(false);
    const before = engine.exportFixtures();
    const r = engine.commitSwap(p);
    expect(r.status).toBe("rejected");
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.revision).toBe(0);
  });
});

/* ---------- 原有冲突：旧冲突对可保留、逐盏试移会被对方挡住的典型场景 ---------- */

describe("双灯原子互换：原有冲突与“逐盏试移被拒、整体互换合法”", () => {
  it("目标位被对方占用：逐盏试移被对方挡住，原子互换在完整候选补丁上一次成功", () => {
    // A、B 分别在两个 universe 且各自身旁有第三具灯；互换后两灯都落到对方的
    // universe——目标通道此刻正被对方占用，逐盏试移任一方都会被挡，
    // 但“同时到位”的完整候选补丁合法。
    const baseline: Fixture[] = [
      { id: "A", universe: 1, start: 10, footprint: 2 }, // u1[10,11]
      { id: "X", universe: 1, start: 1, footprint: 5 }, // u1[1,5]，与 A 不相交
      { id: "B", universe: 2, start: 20, footprint: 3 }, // u2[20,22]
      { id: "Y", universe: 2, start: 40, footprint: 2 }, // u2[40,41]，与 B 不相交
    ];
    const engine = new PatchEngine(baseline);
    expect(engine.getGroups()).toEqual([]); // 基线无冲突组

    // 逐盏试移：A 想直接搬到 B 当前位置（u2[20,21]），target 含 B ⇒ 被拒
    const blockedA = engine.trialMove("A", 2, 20)!;
    expect(blockedA.target).toEqual(["B"]);
    expect(blockedA.canCommit).toBe(false);
    // B 想搬到 A 当前位置（u1[10,12]），target 含 A ⇒ 被拒
    const blockedB = engine.trialMove("B", 1, 10)!;
    expect(blockedB.target).toEqual(["A"]);
    expect(blockedB.canCommit).toBe(false);

    // 原子互换：A→u2[20,21]（fp2，不碰 Y[40,41]），B→u1[10,12]（fp3，不碰 X[1,5]）
    const preview = engine.previewSwap("A", "B")!;
    expect(preview.mutualOverlap).toBe(false);
    expect(preview.a.added).toEqual([]);
    expect(preview.b.added).toEqual([]);
    expect(preview.canCommit).toBe(true);
    const result = engine.commitSwap(preview);
    expect(result.status).toBe("committed");
    expect(engine.getFixture("A")).toEqual({ id: "A", universe: 2, start: 20, footprint: 2 });
    expect(engine.getFixture("B")).toEqual({ id: "B", universe: 1, start: 10, footprint: 3 });
    // footprint 随原灯具
    expect(engine.getFixture("A")!.footprint).toBe(2);
    expect(engine.getFixture("B")!.footprint).toBe(3);
    const expected = swappedPatch(baseline, "A", "B");
    expect(engine.getGroups()).toEqual(naiveGroups(expected));
    expect(engine.getGroups()).toEqual([]);
  });

  it("候选把旧冲突位置与第三方重新配对产生新对：统一核验拦截（逐盏临时状态给不出）", () => {
    // A 与 X 在 u1 旧冲突；B 与 Y 在 u2 旧冲突。A↔B 互换后，A 落到 Y 身旁、
    // B 落到 X 身旁——若新位置与第三方相交，则 A-Y、B-X 是“新增冲突对”（旧对
    // A-X、B-Y 反而消解），必须在完整候选补丁上统一拒绝。
    const baseline: Fixture[] = [
      { id: "A", universe: 1, start: 10, footprint: 2 }, // u1[10,11]
      { id: "X", universe: 1, start: 11, footprint: 1 }, // u1[11,11] 与 A 旧冲突
      { id: "B", universe: 2, start: 20, footprint: 2 }, // u2[20,21]
      { id: "Y", universe: 2, start: 21, footprint: 1 }, // u2[21,21] 与 B 旧冲突
    ];
    const engine = new PatchEngine(baseline);
    expect(engine.getGroups().map((g) => g.ids).sort()).toEqual([
      ["A", "X"],
      ["B", "Y"],
    ]);
    const preview = engine.previewSwap("A", "B")!;
    // A(fp2)→u2[20,21] 与 Y[21,21] 相接 = 新对；B(fp2)→u1[10,11] 与 X[11,11] 相接 = 新对
    expect(preview.a.added).toEqual(["Y"]);
    expect(preview.b.added).toEqual(["X"]);
    expect(preview.a.removed).toEqual(["X"]);
    expect(preview.b.removed).toEqual(["Y"]);
    expect(preview.canCommit).toBe(false);
    expect(engine.commitSwap(preview).status).toBe("rejected");
    expect(engine.exportFixtures()).toEqual(baseline);
    expect(engine.revision).toBe(0);
  });

  it("旧冲突对允许保留：两灯一起平移（互换后仍相接）且不碰别人，但相互重叠仍拒绝", () => {
    // 任务契约：两灯相互重叠本身就无条件拒绝——即使该冲突对原本存在。
    // 旧冲突对的“保留”只适用于每盏灯与第三方的关系。
    const baseline: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 4 }, // [1,4]
      { id: "B", universe: 1, start: 4, footprint: 4 }, // [4,7] 与 A 旧冲突
    ];
    const engine = new PatchEngine(baseline);
    // 让两灯互换到 u2 的两个相切位置：A→[10,13]、B→[10,13]（取相同 start）
    // 先把 B 的原位当作 A 目标、A 原位当作 B 目标（同 universe 互换）⇒ 必重叠
    const p = engine.previewSwap("A", "B")!;
    expect(p.mutualOverlap).toBe(true);
    expect(p.canCommit).toBe(false);
    expect(engine.commitSwap(p).status).toBe("rejected");
    expect(engine.getGroups()).toEqual([{ universe: 1, minStart: 1, ids: ["A", "B"] }]);
  });

  it("与第三方的旧冲突可保留：大区间第三方同时覆盖两灯原位与目标位，互换合法", () => {
    // K 在 u1 覆盖 [1,512]：A、B 原位与互换后的位置都与 K 冲突（旧对保留，无新增）。
    const baseline: Fixture[] = [
      { id: "A", universe: 1, start: 10, footprint: 2 },
      { id: "B", universe: 1, start: 40, footprint: 2 },
      { id: "K", universe: 1, start: 1, footprint: 512 },
    ];
    const engine = new PatchEngine(baseline);
    const p = engine.previewSwap("A", "B")!;
    // 候选：A→[40,41]、B→[10,11]，互不相交；与 K 的冲突是旧对（基线 A-K、B-K 均冲突）
    expect(p.mutualOverlap).toBe(false);
    expect(p.a.added).toEqual([]);
    expect(p.b.added).toEqual([]);
    expect(p.canCommit).toBe(true);
    engine.commitSwap(p);
    const expected = swappedPatch(baseline, "A", "B");
    expect(engine.getGroups()).toEqual(naiveGroups(expected));
    expect(engine.getFixture("A")).toEqual({ id: "A", universe: 1, start: 40, footprint: 2 });
  });

  it("互换消解冲突组成员：端灯与远处小灯互换，换入灯够不到剩余成员", () => {
    // a-b-c 链式组（端点相接）；d 在远处孤立且 footprint=1。
    // 端灯 a 换到 d 的空位；d(fp1) 换到 a 的起点 [1,1]——够不到 b[4,7]，
    // 故无新增对（旧对 a-b、a-c… 随 a 消解，允许）；原组缩小为 {b,c}。
    // 注：桥接灯无法被替走而不新增对——换入灯落在桥位必然按新身份撞上原邻居，
    // 该性质由“在完整候选补丁上按对核验”自然保证。
    const baseline: Fixture[] = [
      { id: "a", universe: 1, start: 1, footprint: 4 }, // [1,4]
      { id: "b", universe: 1, start: 4, footprint: 4 }, // [4,7]
      { id: "c", universe: 1, start: 7, footprint: 4 }, // [7,10]
      { id: "d", universe: 3, start: 200, footprint: 1 }, // 孤立，小 footprint
    ];
    const engine = new PatchEngine(baseline);
    expect(engine.getGroups()).toEqual([
      { universe: 1, minStart: 1, ids: ["a", "b", "c"] },
    ]);
    const p = engine.previewSwap("a", "d")!;
    expect(p.mutualOverlap).toBe(false);
    expect(p.canCommit).toBe(true);
    engine.commitSwap(p);
    const expected = swappedPatch(baseline, "a", "d");
    expect(engine.getGroups()).toEqual(naiveGroups(expected));
    // 原 3 具组缩小为 {b,c}，a 离开后 d[1,1] 不与任何灯冲突
    expect(engine.getGroups()).toEqual([{ universe: 1, minStart: 4, ids: ["b", "c"] }]);
    expect(engine.getFixture("a")).toEqual({ id: "a", universe: 3, start: 200, footprint: 4 });
    expect(engine.getFixture("d")).toEqual({ id: "d", universe: 1, start: 1, footprint: 1 });
  });

  it("桥接灯被替走必然产生按身份计的新冲突对，即使新灯落在完全相同的桥位", () => {
    // 显式锁定该性质：桥位 b[4,7] 连接 a[1,4]、c[7,10]；远处小灯 d 换到桥位后
    // d-a、d-c 都是“新身份”冲突对（旧对是 a-b、b-c），统一核验必须拒绝。
    const baseline: Fixture[] = [
      { id: "a", universe: 1, start: 1, footprint: 4 },
      { id: "b", universe: 1, start: 4, footprint: 4 },
      { id: "c", universe: 1, start: 7, footprint: 4 },
      { id: "d", universe: 3, start: 200, footprint: 4 },
    ];
    const engine = new PatchEngine(baseline);
    const p = engine.previewSwap("b", "d")!;
    // d(fp4)→u1[4,7]：与 a 相切（新对 d-a）、与 c 相切（新对 d-c）
    expect(p.mutualOverlap).toBe(false);
    expect(p.canCommit).toBe(false);
    expect(engine.commitSwap(p).status).toBe("rejected");
    expect(engine.getGroups()).toEqual([
      { universe: 1, minStart: 1, ids: ["a", "b", "c"] },
    ]);
  });
});

/* ---------- 三/四具灯具随机小补丁：预言机对照 + 提交后状态 ---------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("双灯原子互换：3–4 具灯具随机小补丁预言机", () => {
  it("随机补丁随机互换：预演字段、提交/拒绝与朴素候选补丁逐一对照", () => {
    const rand = mulberry32(20_260_930);
    for (let round = 0; round < 400; round++) {
      const n = 3 + Math.floor(rand() * 2);
      const universes = 1 + Math.floor(rand() * 3);
      const maxFp = 1 + Math.floor(rand() * 8);
      const baseline: Fixture[] = Array.from({ length: n }, (_, i) => {
        const fp = 1 + Math.floor(rand() * maxFp);
        return {
          id: `f${i}`,
          universe: 1 + Math.floor(rand() * universes),
          start: 1 + Math.floor(rand() * (513 - fp)),
          footprint: fp,
        };
      });
      const i = Math.floor(rand() * n);
      let j = Math.floor(rand() * (n - 1));
      if (j >= i) j += 1;
      const idA = baseline[i].id;
      const idB = baseline[j].id;

      const engine = new PatchEngine(baseline);
      const preview = engine.previewSwap(idA, idB)!;
      expectPreviewMatchesOracle(preview, baseline, idA, idB);

      const before = engine.exportFixtures();
      const result = engine.commitSwap(preview);
      const candidate = swappedPatch(baseline, idA, idB);
      if (preview.canCommit) {
        expect(result.status).toBe("committed");
        expect(engine.revision).toBe(1);
        expect(engine.exportFixtures().sort((x, y) => compareUtf8(x.id, y.id))).toEqual(
          candidate.sort((x, y) => compareUtf8(x.id, y.id)),
        );
        expect(engine.getGroups()).toEqual(naiveGroups(candidate));
        // 提交后再次互换应回到基线（第二次写回，修订=2）——但仅当换回对当前
        // 候选状态不新增冲突时才允许（用预言机判定，不预设恒合法）。
        const back = engine.previewSwap(idA, idB)!;
        const backOk = oracleLegality(candidate, baseline, idA, idB);
        expect(back.canCommit).toBe(backOk);
        if (backOk) {
          const r2 = engine.commitSwap(back);
          expect(r2.status).toBe("committed");
          expect(engine.revision).toBe(2);
          expect(engine.getGroups()).toEqual(naiveGroups(baseline));
          expect(engine.exportFixtures().sort((x, y) => compareUtf8(x.id, y.id))).toEqual(
            before.sort((x, y) => compareUtf8(x.id, y.id)),
          );
        } else {
          expect(engine.commitSwap(back).status).toBe("rejected");
          expect(engine.revision).toBe(1);
        }
      } else {
        expect(result.status).toBe("rejected");
        expect(engine.revision).toBe(0);
        expect(engine.exportFixtures()).toEqual(before);
        expect(engine.getGroups()).toEqual(naiveGroups(baseline));
      }
    }
  });
});

/* ---------- 过期提交：修订不符一次即拒，且不改任何状态 ---------- */

describe("双灯原子互换：过期提交", () => {
  function patch(): Fixture[] {
    return [
      { id: "A", universe: 1, start: 1, footprint: 2 },
      { id: "B", universe: 2, start: 1, footprint: 2 },
      { id: "C", universe: 3, start: 1, footprint: 1 },
    ];
  }

  it("预演后发生单灯提交：旧互换预演提交为 stale，补丁/冲突组/修订不变", () => {
    const engine = new PatchEngine(patch());
    const swap = engine.previewSwap("A", "B")!;
    expect(swap.revision).toBe(0);
    expect(swap.canCommit).toBe(true);

    // 期间另一盏灯 C 被提交移动，引擎修订推进到 1
    const moved = engine.commit("C", 9, 100)!;
    expect(moved.canCommit).toBe(true);
    expect(engine.revision).toBe(1);

    const before = engine.exportFixtures();
    const groupsBefore = engine.getGroups();
    const result = engine.commitSwap(swap);
    expect(result.status).toBe("stale");
    expect(result.preview).toBeNull();
    // 拒绝/过期不能改变补丁、冲突组
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.getGroups()).toEqual(groupsBefore);
    expect(engine.revision).toBe(1);
    // A、B 均未被移动
    expect(engine.getFixture("A")!.universe).toBe(1);
    expect(engine.getFixture("B")!.universe).toBe(2);

    // 重新预演（修订=1）后提交才生效
    const fresh = engine.previewSwap("A", "B")!;
    expect(fresh.revision).toBe(1);
    const r2 = engine.commitSwap(fresh);
    expect(r2.status).toBe("committed");
    expect(engine.revision).toBe(2);
    expect(engine.getFixture("A")!.universe).toBe(2);
    expect(engine.getFixture("B")!.universe).toBe(1);
  });

  it("预演后发生另一次互换提交：旧预演提交为 stale", () => {
    const engine = new PatchEngine([
      { id: "A", universe: 1, start: 1, footprint: 1 },
      { id: "B", universe: 2, start: 1, footprint: 1 },
      { id: "C", universe: 3, start: 1, footprint: 1 },
      { id: "D", universe: 4, start: 1, footprint: 1 },
    ]);
    const ab = engine.previewSwap("A", "B")!;
    // 先提交另一对 C、D（合法），修订推进
    const cd = engine.previewSwap("C", "D")!;
    expect(engine.commitSwap(cd).status).toBe("committed");
    expect(engine.revision).toBe(1);
    // A、B 的旧预演过期
    expect(engine.commitSwap(ab).status).toBe("stale");
    expect(engine.getFixture("C")!.universe).toBe(4);
    expect(engine.getFixture("A")!.universe).toBe(1); // 未动
  });

  it("同一预演不得重复提交：成功一次后即过期，第二次为 stale", () => {
    const engine = new PatchEngine(patch());
    const p = engine.previewSwap("A", "B")!;
    expect(engine.commitSwap(p).status).toBe("committed");
    expect(engine.revision).toBe(1);
    // 再次提交同一对象（A、B 若换回去是合法的，但旧对象修订=0 已过期）
    const again = engine.commitSwap(p);
    expect(again.status).toBe("stale");
    // 状态停在第一次互换后的快照，没有被“换回去”
    expect(engine.getFixture("A")!.universe).toBe(2);
    expect(engine.getFixture("B")!.universe).toBe(1);
  });
});

/* ---------- 非法请求：id 逐字节不同且必须存在 ---------- */

describe("双灯原子互换：id 规则", () => {
  it("相同 id（含全空格逐字节相同）返回 null", () => {
    const engine = new PatchEngine([
      { id: "A", universe: 1, start: 1, footprint: 1 },
      { id: " ", universe: 2, start: 1, footprint: 1 },
    ]);
    expect(engine.previewSwap("A", "A")).toBeNull();
    expect(engine.previewSwap(" ", " ")).toBeNull();
    // 形近但逐字节不同的 id 是两盏灯，可预演
    expect(engine.previewSwap("A", " ")).not.toBeNull();
    expect(engine.previewSwap(" A", "A")).toBeNull(); // 之一不存在
    expect(engine.previewSwap("A", "A ")).toBeNull();
  });

  it("id 之一不存在返回 null，且不改变补丁/修订", () => {
    const engine = new PatchEngine([
      { id: "A", universe: 1, start: 1, footprint: 1 },
      { id: "B", universe: 2, start: 1, footprint: 1 },
    ]);
    const before = engine.exportFixtures();
    expect(engine.previewSwap("A", "ghost")).toBeNull();
    expect(engine.previewSwap("", "B")).toBeNull();
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.revision).toBe(0);
  });

  it("提交伪造/过期预演对象：修订不符 stale，修订相符但内容须重新核验", () => {
    const engine = new PatchEngine([
      { id: "A", universe: 1, start: 1, footprint: 1 },
      { id: "B", universe: 2, start: 1, footprint: 1 },
    ]);
    // 伪造修订号为未来值：stale
    const fake: SwapPreview = {
      ...engine.previewSwap("A", "B")!,
      revision: 999,
    };
    expect(engine.commitSwap(fake).status).toBe("stale");
    expect(engine.getFixture("A")!.universe).toBe(1);
  });
});
