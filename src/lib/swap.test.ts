import { describe, expect, it } from "vitest";
import {
  ConflictGroup,
  Fixture,
  PatchEngine,
  compareGroups,
  compareUtf8,
  computeGroups,
  endOf,
} from "./dmx";

/* ====================================================================== */
/* 独立枚举预言机：直接在“当前补丁 / 完整候选补丁”上 O(n²) 枚举冲突对，     */
/* 与 PatchEngine 的索引式实现完全无关。小补丁专用。                        */
/* ====================================================================== */

function intersects(a: Fixture, b: Fixture): boolean {
  return a.universe === b.universe && a.start <= endOf(b) && b.start <= endOf(a);
}

/** 补丁中全部无序冲突对，键为 id 字节序排序后的拼接。 */
function conflictPairs(patch: Fixture[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < patch.length; i++) {
    for (let j = i + 1; j < patch.length; j++) {
      if (intersects(patch[i], patch[j])) {
        const [x, y] = [patch[i].id, patch[j].id].sort(compareUtf8);
        pairs.add(`${x} ${y}`);
      }
    }
  }
  return pairs;
}

/** 朴素 O(n) 直接冲突：与指定位置相交的灯具 id（排除 excludeId），UTF-8 字节序。 */
function naiveHits(
  patch: Fixture[],
  excludeId: string,
  universe: number,
  start: number,
  footprint: number,
): string[] {
  const probe: Fixture = { id: excludeId, universe, start, footprint };
  return patch
    .filter((f) => f.id !== excludeId && intersects(f, probe))
    .map((f) => f.id)
    .sort(compareUtf8);
}

/** 完整候选补丁：两灯互换 universe/start，footprint 仍随原灯具。 */
function swappedPatch(patch: Fixture[], idA: string, idB: string): Fixture[] {
  const fa = patch.find((f) => f.id === idA)!;
  const fb = patch.find((f) => f.id === idB)!;
  return patch.map((f) => {
    if (f.id === idA) return { ...f, universe: fb.universe, start: fb.start };
    if (f.id === idB) return { ...f, universe: fa.universe, start: fa.start };
    return { ...f };
  });
}

interface OracleSwap {
  aFits: boolean;
  bFits: boolean;
  mutualOverlap: boolean;
  aOrigin: string[];
  bOrigin: string[];
  aTarget: string[];
  bTarget: string[];
  newPairs: Array<[string, string]>;
  canCommit: boolean;
}

/** 独立枚举：预演结果的全部字段。 */
function oracleSwap(patch: Fixture[], idA: string, idB: string): OracleSwap {
  const fa = patch.find((f) => f.id === idA)!;
  const fb = patch.find((f) => f.id === idB)!;
  const candidate = swappedPatch(patch, idA, idB);
  const ca = candidate.find((f) => f.id === idA)!;
  const cb = candidate.find((f) => f.id === idB)!;

  const aFits = ca.start + ca.footprint <= 513;
  const bFits = cb.start + cb.footprint <= 513;
  const mutualOverlap = intersects(ca, cb);

  const aOrigin = naiveHits(patch, idA, fa.universe, fa.start, fa.footprint);
  const bOrigin = naiveHits(patch, idB, fb.universe, fb.start, fb.footprint);
  // 候选中对方已换位：目标位冲突枚举不含对方
  const aTarget = naiveHits(
    candidate.filter((f) => f.id !== idB),
    idA,
    ca.universe,
    ca.start,
    ca.footprint,
  );
  const bTarget = naiveHits(
    candidate.filter((f) => f.id !== idA),
    idB,
    cb.universe,
    cb.start,
    cb.footprint,
  );

  // 新增冲突对：候选有而当前没有、且涉及移动灯的对（不含 (A,B) 自身——由相互重叠判定）
  const oldPairs = conflictPairs(patch);
  const candPairs = conflictPairs(candidate);
  const newPairs: Array<[string, string]> = [];
  for (const [moved, other] of [
    [idA, aTarget],
    [idB, bTarget],
  ] as Array<[string, string[]]>) {
    for (const id of other) {
      const key = [moved, id].sort(compareUtf8).join(" ");
      if (!oldPairs.has(key) && candPairs.has(key)) newPairs.push([moved, id]);
    }
  }
  newPairs.sort((p, q) => compareUtf8(p[0], q[0]) || compareUtf8(p[1], q[1]));

  return {
    aFits,
    bFits,
    mutualOverlap,
    aOrigin,
    bOrigin,
    aTarget,
    bTarget,
    newPairs,
    canCommit: aFits && bFits && !mutualOverlap && newPairs.length === 0,
  };
}

/** 朴素 O(n²) 两两相交 + 并查集分组预言机（与 dmx.test.ts 同款，独立核对分组）。 */
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

function sortedExport(engine: PatchEngine): Fixture[] {
  return engine.exportFixtures().sort((x, y) => compareUtf8(x.id, y.id));
}

/** 断言引擎预演与独立枚举预言机逐字段一致。 */
function expectPreviewMatchesOracle(engine: PatchEngine, patch: Fixture[], idA: string, idB: string) {
  const trial = engine.trialSwap(idA, idB);
  expect(trial).not.toBeNull();
  const oracle = oracleSwap(patch, idA, idB);
  expect(trial!.aFits).toBe(oracle.aFits);
  expect(trial!.bFits).toBe(oracle.bFits);
  expect(trial!.mutualOverlap).toBe(oracle.mutualOverlap);
  expect(trial!.aOrigin).toEqual(oracle.aOrigin);
  expect(trial!.bOrigin).toEqual(oracle.bOrigin);
  expect(trial!.aTarget).toEqual(oracle.aTarget);
  expect(trial!.bTarget).toEqual(oracle.bTarget);
  expect(trial!.newPairs).toEqual(oracle.newPairs);
  expect(trial!.canCommit).toBe(oracle.canCommit);
  return trial!;
}

/* ---------- 基本互换：逐盏试移被拒，整体互换合法 ---------- */

describe("原子互换：逐盏试移被拒而整体互换合法", () => {
  const patch: Fixture[] = [
    { id: "A", universe: 1, start: 1, footprint: 4 }, // u1 [1,4]
    { id: "B", universe: 2, start: 10, footprint: 4 }, // u2 [10,13]
  ];

  it("逐盏试移因对方占着目标通道而被拒", () => {
    const engine = new PatchEngine(patch);
    const t = engine.trialMove("A", 2, 10)!;
    expect(t.target).toEqual(["B"]);
    expect(t.canCommit).toBe(false);
    // 先移 B 同理被拒：第一次试移的临时状态不能作为结论
    expect(engine.trialMove("B", 1, 1)!.canCommit).toBe(false);
  });

  it("互换预演在完整候选补丁上判定合法，提交一次生效", () => {
    const engine = new PatchEngine(patch);
    const preview = engine.trialSwap("A", "B")!;
    expect(preview.a).toEqual({ id: "A", universe: 1, start: 1, footprint: 4 });
    expect(preview.b).toEqual({ id: "B", universe: 2, start: 10, footprint: 4 });
    expect(preview.aTargetUniverse).toBe(2);
    expect(preview.aTargetStart).toBe(10);
    expect(preview.bTargetUniverse).toBe(1);
    expect(preview.bTargetStart).toBe(1);
    expect(preview.aFits).toBe(true);
    expect(preview.bFits).toBe(true);
    expect(preview.mutualOverlap).toBe(false);
    expect(preview.aTarget).toEqual([]);
    expect(preview.bTarget).toEqual([]);
    expect(preview.newPairs).toEqual([]);
    expect(preview.canCommit).toBe(true);
    expect(preview.revision).toBe(engine.revision);

    const r = engine.commitSwap("A", "B", preview.revision);
    expect(r.status).toBe("committed");
    expect(engine.getFixture("A")).toEqual({ id: "A", universe: 2, start: 10, footprint: 4 });
    expect(engine.getFixture("B")).toEqual({ id: "B", universe: 1, start: 1, footprint: 4 });
    expect(engine.getGroups()).toEqual(computeGroups(engine.exportFixtures()));
  });
});

/* ---------- 输入规则：两个不同的逐字节 id ---------- */

describe("原子互换：id 规则", () => {
  it("id 相同或任一不存在时预演返回 null", () => {
    const engine = new PatchEngine([
      { id: "A", universe: 1, start: 1, footprint: 2 },
      { id: " A", universe: 2, start: 1, footprint: 2 }, // 前导空格：与 "A" 不同
      { id: "B", universe: 3, start: 1, footprint: 2 },
    ]);
    expect(engine.trialSwap("A", "A")).toBeNull();
    expect(engine.trialSwap("A", "ghost")).toBeNull();
    expect(engine.trialSwap("ghost", "A")).toBeNull();
    // 逐字节：形近但不存在的 id 同样为 null
    expect(engine.trialSwap("A ", "B")).toBeNull();
    // "A" 与 " A" 是两具不同灯具，可正常互换
    const preview = engine.trialSwap("A", " A")!;
    expect(preview.canCommit).toBe(true);
    const r = engine.commitSwap("A", " A", preview.revision);
    expect(r.status).toBe("committed");
    expect(engine.getFixture("A")).toEqual({ id: "A", universe: 2, start: 1, footprint: 2 });
    expect(engine.getFixture(" A")).toEqual({ id: " A", universe: 1, start: 1, footprint: 2 });
  });

  it("修订匹配但 id 失效时提交为 rejected，补丁不变", () => {
    const engine = new PatchEngine([{ id: "A", universe: 1, start: 1, footprint: 2 }]);
    const before = engine.exportFixtures();
    const r = engine.commitSwap("A", "A", engine.revision);
    expect(r).toEqual({ status: "rejected", trial: null });
    expect(engine.exportFixtures()).toEqual(before);
  });
});

/* ---------- 不同 footprint：footprint 仍随原灯具 ---------- */

describe("原子互换：不同 footprint", () => {
  it("互换后 footprint 不随位置走，目标区间按各自 footprint 计算", () => {
    const patch: Fixture[] = [
      { id: "wide", universe: 1, start: 1, footprint: 10 }, // u1 [1,10]
      { id: "narrow", universe: 2, start: 100, footprint: 3 }, // u2 [100,102]
    ];
    const engine = new PatchEngine(patch);
    const preview = expectPreviewMatchesOracle(engine, patch, "wide", "narrow");
    expect(preview.canCommit).toBe(true);
    // 目标区间：wide → u2 [100,109]，narrow → u1 [1,3]
    expect(preview.aTargetUniverse).toBe(2);
    expect(preview.aTargetStart).toBe(100);
    expect(preview.bTargetUniverse).toBe(1);
    expect(preview.bTargetStart).toBe(1);
    engine.commitSwap("wide", "narrow", preview.revision);
    expect(engine.getFixture("wide")).toEqual({ id: "wide", universe: 2, start: 100, footprint: 10 });
    expect(engine.getFixture("narrow")).toEqual({ id: "narrow", universe: 1, start: 1, footprint: 3 });
  });

  it("footprint 较大者换到高起始通道可越界：预演标出，提交拒绝且补丁不变", () => {
    const patch: Fixture[] = [
      { id: "wide", universe: 1, start: 1, footprint: 10 }, // u1 [1,10]
      { id: "high", universe: 2, start: 510, footprint: 3 }, // u2 [510,512] 自身合法
    ];
    const engine = new PatchEngine(patch);
    const before = engine.exportFixtures();
    const groupsBefore = engine.getGroups();
    const preview = engine.trialSwap("wide", "high")!;
    // wide(fp10) 到 510：510+10=520 > 513 越界；high(fp3) 到 1：1+3=4 合法
    expect(preview.aFits).toBe(false);
    expect(preview.bFits).toBe(true);
    expect(preview.canCommit).toBe(false);
    const r = engine.commitSwap("wide", "high", preview.revision);
    expect(r.status).toBe("rejected");
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.getGroups()).toEqual(groupsBefore);
  });
});

/* ---------- 通道上界边界 ---------- */

describe("原子互换：通道上界边界", () => {
  it("目标 start+footprint = 513 恰好合法，= 514 越界", () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 10 },
      { id: "B", universe: 2, start: 503, footprint: 10 }, // [503,512] 合法
    ];
    const engine = new PatchEngine(patch);
    // A(fp10) → 503：503+10 = 513 恰好合法；B(fp10) → 1：合法
    const ok = engine.trialSwap("A", "B")!;
    expect(ok.aFits).toBe(true);
    expect(ok.bFits).toBe(true);
    expect(ok.canCommit).toBe(true);

    const patch2: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 10 },
      { id: "B", universe: 2, start: 504, footprint: 9 }, // [504,512] 合法
    ];
    const engine2 = new PatchEngine(patch2);
    // A(fp10) → 504：504+10 = 514 > 513 越界
    const bad = engine2.trialSwap("A", "B")!;
    expect(bad.aFits).toBe(false);
    expect(bad.canCommit).toBe(false);
  });

  it("通道 512 端点：fp1 灯具互换到 [512,512] 合法", () => {
    const patch: Fixture[] = [
      { id: "edge", universe: 1, start: 512, footprint: 1 },
      { id: "head", universe: 2, start: 1, footprint: 1 },
    ];
    const engine = new PatchEngine(patch);
    const preview = engine.trialSwap("edge", "head")!;
    expect(preview.canCommit).toBe(true);
    engine.commitSwap("edge", "head", preview.revision);
    expect(engine.getFixture("edge")).toEqual({ id: "edge", universe: 2, start: 1, footprint: 1 });
    expect(engine.getFixture("head")).toEqual({ id: "head", universe: 1, start: 512, footprint: 1 });
  });
});

/* ---------- 两灯相互重叠 ---------- */

describe("原子互换：两灯相互重叠", () => {
  it("当前即重叠的两灯互换后仍重叠：拒绝且补丁不变", () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 4 }, // [1,4]
      { id: "B", universe: 1, start: 3, footprint: 4 }, // [3,6] 与 A 旧冲突
    ];
    const engine = new PatchEngine(patch);
    const before = engine.exportFixtures();
    const preview = engine.trialSwap("A", "B")!;
    // 互换后 A→[3,6]、B→[1,4]，仍相互重叠
    expect(preview.mutualOverlap).toBe(true);
    expect(preview.canCommit).toBe(false);
    // 原位冲突列表含对方（忠实展示当前状态）
    expect(preview.aOrigin).toEqual(["B"]);
    expect(preview.bOrigin).toEqual(["A"]);
    const r = engine.commitSwap("A", "B", preview.revision);
    expect(r.status).toBe("rejected");
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.getGroups()).toEqual([{ universe: 1, minStart: 1, ids: ["A", "B"] }]);
  });

  it("同 universe 不重叠的两灯互换合法，分组随候选重算", () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 4 }, // [1,4]
      { id: "B", universe: 1, start: 10, footprint: 4 }, // [10,13]
      { id: "C", universe: 1, start: 4, footprint: 4 }, // [4,7] 与 A 旧冲突
    ];
    const engine = new PatchEngine(patch);
    expect(engine.getGroups()).toEqual([{ universe: 1, minStart: 1, ids: ["A", "C"] }]);
    const preview = engine.trialSwap("A", "B")!;
    // A→[10,13] 无冲突；B→[1,4] 撞 C[4,7]：新增对 (B,C) —— 见下例；此处 C 在 [4,7]，B→[1,4] 端点相切即相交
    expect(preview.bTarget).toEqual(["C"]);
    expect(preview.newPairs).toEqual([["B", "C"]]);
    expect(preview.canCommit).toBe(false);
  });
});

/* ---------- 原有冲突：旧对可保留，新对阻断 ---------- */

describe("原子互换：原有冲突语义", () => {
  it("旧冲突对保留不阻断：第三方同时覆盖两灯新旧位置", () => {
    const patch: Fixture[] = [
      { id: "C", universe: 1, start: 1, footprint: 512 }, // 覆盖整个 universe
      { id: "A", universe: 1, start: 10, footprint: 5 }, // 与 C 旧冲突
      { id: "B", universe: 1, start: 20, footprint: 5 }, // 与 C 旧冲突
    ];
    const engine = new PatchEngine(patch);
    const groupsBefore = engine.getGroups();
    const preview = engine.trialSwap("A", "B")!;
    // A→[20,24] 仍撞 C（旧对 (A,C)），B→[10,14] 仍撞 C（旧对 (B,C)）：无新增对
    expect(preview.aTarget).toEqual(["C"]);
    expect(preview.bTarget).toEqual(["C"]);
    expect(preview.newPairs).toEqual([]);
    expect(preview.mutualOverlap).toBe(false);
    expect(preview.canCommit).toBe(true);
    const r = engine.commitSwap("A", "B", preview.revision);
    expect(r.status).toBe("committed");
    // 冲突对集合不变：仍是 (A,C)、(B,C)
    expect(conflictPairs(engine.exportFixtures())).toEqual(conflictPairs(patch));
    expect(engine.getGroups()).toEqual(groupsBefore);
  });

  it("与其他灯具的新增冲突对阻断提交，补丁与冲突组不变", () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 4 }, // [1,4] 与 C 旧冲突
      { id: "C", universe: 1, start: 3, footprint: 4 }, // [3,6]
      { id: "B", universe: 2, start: 10, footprint: 4 }, // u2 [10,13]
    ];
    const engine = new PatchEngine(patch);
    const before = engine.exportFixtures();
    const groupsBefore = engine.getGroups();
    const revBefore = engine.revision;
    const preview = engine.trialSwap("A", "B")!;
    // A→u2[10,13] 无冲突；B→u1[1,4] 撞 C[3,6]：(B,C) 是新增对
    expect(preview.aTarget).toEqual([]);
    expect(preview.bTarget).toEqual(["C"]);
    expect(preview.newPairs).toEqual([["B", "C"]]);
    expect(preview.canCommit).toBe(false);
    const r = engine.commitSwap("A", "B", preview.revision);
    expect(r.status).toBe("rejected");
    // 拒绝不改变补丁、冲突组与修订号
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.getGroups()).toEqual(groupsBefore);
    expect(engine.revision).toBe(revBefore);
  });

  it("互换可消除旧冲突对：只有新增被禁止，消除被允许", () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 4 }, // [1,4] 与 C 旧冲突
      { id: "C", universe: 1, start: 3, footprint: 4 }, // [3,6]
      { id: "B", universe: 2, start: 10, footprint: 1 }, // u2 [10,10] fp1
    ];
    const engine = new PatchEngine(patch);
    const preview = engine.trialSwap("A", "B")!;
    // A→u2[10,13] 无冲突；B(fp1)→u1[1,1] 与 C[3,6] 不相交：旧对 (A,C) 被消除，无新增
    expect(preview.bTarget).toEqual([]);
    expect(preview.newPairs).toEqual([]);
    expect(preview.canCommit).toBe(true);
    engine.commitSwap("A", "B", preview.revision);
    expect(engine.getGroups()).toEqual([]); // C 孤立，组消失
    expect(engine.getFixture("B")).toEqual({ id: "B", universe: 1, start: 1, footprint: 1 });
  });
});

/* ---------- 过期提交：修订号守卫 ---------- */

describe("原子互换：过期提交", () => {
  const patch: Fixture[] = [
    { id: "A", universe: 1, start: 1, footprint: 4 },
    { id: "B", universe: 2, start: 10, footprint: 4 },
    { id: "C", universe: 3, start: 1, footprint: 4 },
  ];

  it("预演后发生单灯提交：旧预演提交为 stale，补丁/冲突组/修订号不再变化", () => {
    const engine = new PatchEngine(patch);
    const preview = engine.trialSwap("A", "B")!;
    expect(preview.canCommit).toBe(true);
    // 期间发生一次无关的单灯提交：引擎修订号前进
    engine.commit("C", 9, 100);
    const before = engine.exportFixtures();
    const groupsBefore = engine.getGroups();
    const revBefore = engine.revision;
    const r = engine.commitSwap("A", "B", preview.revision);
    expect(r.status).toBe("stale");
    expect(engine.exportFixtures()).toEqual(before);
    expect(engine.getGroups()).toEqual(groupsBefore);
    expect(engine.revision).toBe(revBefore);
    // 重新预演后基于新修订可正常提交
    const fresh = engine.trialSwap("A", "B")!;
    expect(fresh.revision).toBe(engine.revision);
    expect(engine.commitSwap("A", "B", fresh.revision).status).toBe("committed");
    expect(engine.getFixture("A")!.universe).toBe(2);
    expect(engine.getFixture("B")!.universe).toBe(1);
  });

  it("同一预演不可二次提交：成功一次后修订号递增，再次提交为 stale", () => {
    const engine = new PatchEngine(patch);
    const preview = engine.trialSwap("A", "B")!;
    expect(engine.commitSwap("A", "B", preview.revision).status).toBe("committed");
    const before = engine.exportFixtures();
    // 同一预演再次提交：已过期，不得再次生效（否则位置会被换回去）
    expect(engine.commitSwap("A", "B", preview.revision).status).toBe("stale");
    expect(engine.exportFixtures()).toEqual(before);
  });

  it("被拒绝的提交不推进修订号：同一预演可重复尝试", () => {
    const blocking: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 4 },
      { id: "C", universe: 1, start: 3, footprint: 4 },
      { id: "B", universe: 2, start: 10, footprint: 4 },
    ];
    const engine = new PatchEngine(blocking);
    const preview = engine.trialSwap("A", "B")!;
    expect(preview.canCommit).toBe(false);
    const revBefore = engine.revision;
    expect(engine.commitSwap("A", "B", preview.revision).status).toBe("rejected");
    expect(engine.revision).toBe(revBefore);
    // 再次以同一预演提交仍是 rejected 而非 stale
    expect(engine.commitSwap("A", "B", preview.revision).status).toBe("rejected");
  });
});

/* ---------- 互换后分组与全量重算一致 ---------- */

describe("原子互换：分组一致性", () => {
  it("跨 universe 互换拆开并重建冲突组", () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 10 }, // u1 [1,10] 桥
      { id: "C", universe: 1, start: 5, footprint: 11 }, // u1 [5,15]
      { id: "B", universe: 2, start: 100, footprint: 4 }, // u2 [100,103]
      { id: "D", universe: 2, start: 102, footprint: 4 }, // u2 [102,105] 与 B 旧冲突
    ];
    const engine = new PatchEngine(patch);
    expect(engine.getGroups()).toEqual([
      { universe: 1, minStart: 1, ids: ["A", "C"] },
      { universe: 2, minStart: 100, ids: ["B", "D"] },
    ]);
    const preview = engine.trialSwap("A", "B")!;
    // A→u2[100,109] 撞 D[102,105]：新增对 (A,D)？—— (A,D) 当前不存在 ⇒ 阻断
    expect(preview.newPairs).toEqual([["A", "D"]]);
    expect(preview.canCommit).toBe(false);

    // 换成与 D 不相交的位置：把 D 挪远，再互换即合法
    const engine2 = new PatchEngine([
      { id: "A", universe: 1, start: 1, footprint: 10 },
      { id: "C", universe: 1, start: 5, footprint: 11 },
      { id: "B", universe: 2, start: 100, footprint: 4 },
      { id: "D", universe: 2, start: 200, footprint: 4 },
    ]);
    const p2 = engine2.trialSwap("A", "B")!;
    expect(p2.canCommit).toBe(true);
    engine2.commitSwap("A", "B", p2.revision);
    // A 到 u2[100,109] 孤立；B 到 u1[1,4] 与 C[5,15] 端点相切？B fp4 → [1,4]，C [5,15] 不相交
    expect(engine2.getGroups()).toEqual(computeGroups(engine2.exportFixtures()));
    expect(engine2.getGroups()).toEqual(naiveGroups(engine2.exportFixtures()));
    expect(engine2.getGroups()).toEqual([]);
  });
});

/* ---------- 随机小补丁：独立枚举预言机全字段对照 ---------- */

describe("原子互换：随机小补丁独立枚举对照", () => {
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

  it("预演字段、提交结果、补丁与分组均与独立枚举一致", () => {
    const rand = mulberry32(2_0261_001);
    for (let round = 0; round < 300; round++) {
      // 小补丁：少 universe、小 footprint，密集冲突以覆盖原有冲突分支
      const n = 2 + Math.floor(rand() * 6);
      const universes = 1 + Math.floor(rand() * 3);
      const patch: Fixture[] = Array.from({ length: n }, (_, i) => {
        const fp = 1 + Math.floor(rand() * (rand() < 0.3 ? 40 : 6));
        return {
          id: `f${i}`,
          universe: 1 + Math.floor(rand() * universes),
          start: 1 + Math.floor(rand() * (513 - fp > 40 ? 40 : 513 - fp)),
          footprint: fp,
        };
      });
      const engine = new PatchEngine(patch);
      const i = Math.floor(rand() * n);
      let j = Math.floor(rand() * n);
      if (j === i) j = (j + 1) % n;
      const idA = patch[i].id;
      const idB = patch[j].id;

      const preview = expectPreviewMatchesOracle(engine, patch, idA, idB);

      // 1/3 概率先制造一次无关变更，使预演过期
      let stale = false;
      if (rand() < 1 / 3) {
        const other = patch[Math.floor(rand() * n)].id;
        const t = engine.trialMove(other, 1 + Math.floor(rand() * 5), 1);
        if (t && t.canCommit) {
          engine.commit(other, t.targetUniverse, t.targetStart);
          stale = true;
        }
      }

      // 过期/拒绝/提交前的权威快照：commitSwap 的任何失败结局都不得改变它
      const before = engine.exportFixtures();
      const revBefore = engine.revision;
      const r = engine.commitSwap(idA, idB, preview.revision);
      if (stale) {
        expect(r.status).toBe("stale");
        expect(engine.exportFixtures()).toEqual(before);
        expect(engine.revision).toBe(revBefore);
        continue;
      }
      const oracle = oracleSwap(patch, idA, idB);
      if (!oracle.canCommit) {
        expect(r.status).toBe("rejected");
        expect(engine.exportFixtures()).toEqual(before);
        expect(engine.revision).toBe(revBefore);
      } else {
        expect(r.status).toBe("committed");
        expect(engine.revision).toBe(revBefore + 1);
        // 补丁与独立构造的完整候选逐一致（footprint 随原灯具）
        const expected = swappedPatch(patch, idA, idB);
        expect(sortedExport(engine)).toEqual(
          [...expected].sort((x, y) => compareUtf8(x.id, y.id)),
        );
        // 候选不产生新增冲突对
        const oldPairs = conflictPairs(patch);
        for (const key of conflictPairs(engine.exportFixtures())) {
          expect(oldPairs.has(key)).toBe(true);
        }
      }
      // 任何结局下：分组与全量重算、并查集预言机一致
      expect(engine.getGroups()).toEqual(computeGroups(engine.exportFixtures()));
      expect(engine.getGroups()).toEqual(naiveGroups(engine.exportFixtures()));
    }
  });
});
