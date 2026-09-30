/**
 * DMX 补丁核心逻辑：导入校验、冲突分组、试移与提交。
 * 契约定义见 README.md；此文件是唯一权威实现，UI 与验收测试共用。
 */

export const INVALID_PATCH = "INVALID_PATCH";
export const MAX_FIXTURES = 200_000;
export const MIN_UNIVERSE = 1;
export const MAX_UNIVERSE = 32_768;
export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 512;
export const MAX_ID_LENGTH = 32;

export interface Fixture {
  id: string;
  universe: number;
  start: number;
  footprint: number;
}

export interface ConflictGroup {
  universe: number;
  minStart: number;
  /** 组内灯具 id，按 UTF-8 字节序排列。 */
  ids: string[];
}

export interface TrialResult {
  /** 试移时刻的灯具快照。 */
  fixture: Fixture;
  targetUniverse: number;
  targetStart: number;
  /** 原位直接冲突 id（UTF-8 字节序）。 */
  origin: string[];
  /** 目标位直接冲突 id（UTF-8 字节序）。 */
  target: string[];
  /** 仅当 target 为空时为 true。 */
  canCommit: boolean;
}

/** 双灯具原子互换中单方（一盏灯）的预演结果。 */
export interface SwapSide {
  /** 预演时刻该灯具的快照（footprint 随原灯具，不参与互换）。 */
  fixture: Fixture;
  /** 互换后的目标 universe（对方原位）。 */
  targetUniverse: number;
  /** 互换后的目标 start（对方原位）。 */
  targetStart: number;
  /** 通道上界：targetStart + fixture.footprint ≤ 513。 */
  inBounds: boolean;
  /** 原位直接冲突 id（当前补丁，不含自身，UTF-8 字节序）。 */
  origin: string[];
  /** 目标位直接冲突 id（完整候选补丁口径，含相互重叠时的对方，UTF-8 字节序）。 */
  target: string[];
  /** 候选相对原位新增的直接冲突 id（target 有、origin 无，UTF-8 字节序）。 */
  added: string[];
  /** 候选相对原位消解的直接冲突 id（origin 有、target 无，UTF-8 字节序）。 */
  removed: string[];
}

/** 双灯具原子互换预演：在完整候选补丁上统一核验，绝不基于逐盏试移的临时状态。 */
export interface SwapPreview {
  /** 预演所依据的引擎修订；提交时必须仍为当前修订。 */
  revision: number;
  a: SwapSide;
  b: SwapSide;
  /** 两灯在候选补丁的新位置上是否相互重叠（无条件拒绝，即使该冲突对原本就存在）。 */
  mutualOverlap: boolean;
  /** 通道合法、两灯不相互重叠、且对其他灯具均无新增冲突时为 true。 */
  canCommit: boolean;
}

/** 原子互换提交结果。 */
export interface SwapCommitResult {
  /** committed：一次生效；rejected：合法性核验未过；stale：预演修订已过期。 */
  status: "committed" | "rejected" | "stale";
  /** committed/rejected 时附带当前引擎状态下重新算出的预演；stale 时为 null。 */
  preview: SwapPreview | null;
}

/** 灯具占用的闭区间右端点（含）。 */
export function endOf(f: Pick<Fixture, "start" | "footprint">): number {
  return f.start + f.footprint - 1;
}

const utf8Encoder = new TextEncoder();

export function encodeUtf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

/** 按 UTF-8 字节序比较两个字节串。 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 按 UTF-8 字节序比较两个字符串（注意：与 JS 默认的 UTF-16 码元序不同）。 */
export function compareUtf8(a: string, b: string): number {
  return compareBytes(encodeUtf8(a), encodeUtf8(b));
}

function isValidId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > MAX_ID_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // 可打印 ASCII：U+0020–U+007E
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function isIntBetween(value: unknown, lo: number, hi: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= lo && value <= hi;
}

export function isValidUniverse(value: unknown): value is number {
  return isIntBetween(value, MIN_UNIVERSE, MAX_UNIVERSE);
}

/**
 * 解析并校验补丁 JSON。任何一项非法即整体返回 null
 * （调用方须显示 INVALID_PATCH 并保留旧补丁）。
 */
export function parsePatch(data: unknown): Fixture[] | null {
  if (!Array.isArray(data) || data.length < 1 || data.length > MAX_FIXTURES) return null;
  const seen = new Set<string>();
  const fixtures: Fixture[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { id, universe, start, footprint } = item as Record<string, unknown>;
    if (!isValidId(id) || seen.has(id)) return null;
    if (!isValidUniverse(universe)) return null;
    if (!isIntBetween(start, MIN_CHANNEL, MAX_CHANNEL)) return null;
    if (!isIntBetween(footprint, MIN_CHANNEL, MAX_CHANNEL)) return null;
    if (start + footprint > MAX_CHANNEL + 1) return null;
    seen.add(id);
    fixtures.push({ id, universe, start, footprint });
  }
  return fixtures;
}

type BytesOf = (id: string) => Uint8Array;

/**
 * 计算单个 universe 的冲突组（相交关系的连通分量，仅保留 ≥2 具灯具的组）。
 * 输入 sorted 必须已按 (start 升序, id UTF-8 字节序) 排序。
 * 产出的组按扫描顺序即 minStart 升序；同一 universe 内 minStart 必不重复，
 * 因为同 universe 同 start 的灯具必然相交、必属同组。
 */
export function groupsOfUniverse(
  universe: number,
  sorted: Fixture[],
  bytesOf: BytesOf,
): ConflictGroup[] {
  const groups: ConflictGroup[] = [];
  let members: Fixture[] = [];
  let groupEnd = 0;
  let minStart = 0;
  const flush = () => {
    if (members.length >= 2) {
      const ids = members.map((f) => f.id).sort((a, b) => compareBytes(bytesOf(a), bytesOf(b)));
      groups.push({ universe, minStart, ids });
    }
    members = [];
  };
  for (const f of sorted) {
    if (members.length > 0 && f.start <= groupEnd) {
      // 闭区间：f.start 落在当前分量已覆盖的 [minStart, groupEnd] 内即相交
      members.push(f);
      const e = endOf(f);
      if (e > groupEnd) groupEnd = e;
    } else {
      flush();
      members = [f];
      groupEnd = endOf(f);
      minStart = f.start;
    }
  }
  flush();
  return groups;
}

/** 组排序：universe 升序，再最小 start 升序，再首 id 的 UTF-8 字节序。 */
export function compareGroups(a: ConflictGroup, b: ConflictGroup): number {
  return (
    a.universe - b.universe ||
    a.minStart - b.minStart ||
    compareUtf8(a.ids[0], b.ids[0])
  );
}

/** 全网核验：对整份补丁计算冲突组，按契约排序。 */
export function computeGroups(fixtures: Fixture[]): ConflictGroup[] {
  const cache = new Map<string, Uint8Array>();
  const bytesOf: BytesOf = (id) => {
    let b = cache.get(id);
    if (!b) {
      b = encodeUtf8(id);
      cache.set(id, b);
    }
    return b;
  };
  const byUniverse = new Map<number, Fixture[]>();
  for (const f of fixtures) {
    const arr = byUniverse.get(f.universe);
    if (arr) arr.push(f);
    else byUniverse.set(f.universe, [f]);
  }
  const groups: ConflictGroup[] = [];
  for (const [universe, arr] of byUniverse) {
    arr.sort((a, b) => a.start - b.start || compareBytes(bytesOf(a.id), bytesOf(b.id)));
    for (const g of groupsOfUniverse(universe, arr, bytesOf)) groups.push(g);
  }
  groups.sort(compareGroups);
  return groups;
}

/**
 * 补丁引擎：持有当前补丁，支持 O(log n + 命中数) 的试移查询，
 * 提交后仅重算受影响 universe 的分组。
 */
export class PatchEngine {
  private readonly fixtures = new Map<string, Fixture>();
  private readonly idBytes = new Map<string, Uint8Array>();
  /** 每个 universe 的灯具数组，按 (start, id 字节序) 排序。 */
  private readonly byUniverse = new Map<number, Fixture[]>();
  private readonly groupsByUniverse = new Map<number, ConflictGroup[]>();
  /**
   * 引擎修订：构造为 0，每次成功写回（单灯提交/双灯互换提交）递增。
   * 预演携带当时的修订；提交时修订不符即过期，调用方须重新预演。
   */
  private rev = 0;

  constructor(patch: Fixture[]) {
    for (const f of patch) {
      const copy: Fixture = { ...f };
      this.fixtures.set(copy.id, copy);
      this.idBytes.set(copy.id, encodeUtf8(copy.id));
      const arr = this.byUniverse.get(copy.universe);
      if (arr) arr.push(copy);
      else this.byUniverse.set(copy.universe, [copy]);
    }
    for (const [universe, arr] of this.byUniverse) {
      arr.sort(this.cmpFixture);
      this.groupsByUniverse.set(universe, this.sweep(universe, arr));
    }
  }

  private readonly bytesOf: BytesOf = (id) => this.idBytes.get(id)!;

  private readonly cmpFixture = (a: Fixture, b: Fixture): number =>
    a.start - b.start || compareBytes(this.idBytes.get(a.id)!, this.idBytes.get(b.id)!);

  private sweep(universe: number, sorted: Fixture[]): ConflictGroup[] {
    return groupsOfUniverse(universe, sorted, this.bytesOf);
  }

  get size(): number {
    return this.fixtures.size;
  }

  /** 当前引擎修订；成功写回一次即 +1。 */
  get revision(): number {
    return this.rev;
  }

  getFixture(id: string): Fixture | undefined {
    const f = this.fixtures.get(id);
    return f ? { ...f } : undefined;
  }

  exportFixtures(): Fixture[] {
    return [...this.fixtures.values()].map((f) => ({ ...f }));
  }

  /** 全部冲突组，按 (universe, 最小 start, 首 id) 排序。 */
  getGroups(): ConflictGroup[] {
    const universes = [...this.groupsByUniverse.keys()].sort((a, b) => a - b);
    const out: ConflictGroup[] = [];
    for (const u of universes) {
      for (const g of this.groupsByUniverse.get(u)!) out.push(g);
    }
    return out;
  }

  /**
   * 列出与区间 [start, start+footprint-1] 在指定 universe 内直接冲突的灯具 id
   * （排除 excludeId 自身以及另一盏互换灯 otherExcludeId，若给出），按 UTF-8 字节序。
   */
  private conflictsAt(
    universe: number,
    start: number,
    footprint: number,
    excludeId: string,
    otherExcludeId?: string,
  ): string[] {
    const arr = this.byUniverse.get(universe);
    if (!arr || arr.length === 0) return [];
    const end = start + footprint - 1;
    // f 与查询区间相交 ⇒ f.start ∈ [start - 511, end]（因 footprint ≤ 512）
    const lo = Math.max(MIN_CHANNEL, start - (MAX_CHANNEL - 1));
    let a = 0;
    let b = arr.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (arr[m].start < lo) a = m + 1;
      else b = m;
    }
    const hits: string[] = [];
    for (let i = a; i < arr.length; i++) {
      const f = arr[i];
      if (f.start > end) break;
      if (f.id !== excludeId && f.id !== otherExcludeId && endOf(f) >= start) hits.push(f.id);
    }
    hits.sort((x, y) => compareBytes(this.idBytes.get(x)!, this.idBytes.get(y)!));
    return hits;
  }

  /**
   * 只读位置索引查询：列出在指定 universe 内与闭区间 [start, start+footprint-1]
   * 直接相交的灯具 id（排除 excludeId 自身），按 UTF-8 字节序。
   * 复杂度 O(log n + 命中数)，供修订复核等外部流程构建约束，避免全量两两扫描。
   */
  conflictingIds(
    universe: number,
    start: number,
    footprint: number,
    excludeId: string,
  ): string[] {
    return this.conflictsAt(universe, start, footprint, excludeId);
  }

  /**
   * 试移：分别列出灯具在原位与目标位的直接冲突 id。
   * 输入非法（universe 越界、start 越界或 start+footprint > 513）返回 null。
   */
  trialMove(id: string, universe: number, start: number): TrialResult | null {
    const f = this.fixtures.get(id);
    if (!f) return null;
    if (!isValidUniverse(universe)) return null;
    if (!isIntBetween(start, MIN_CHANNEL, MAX_CHANNEL)) return null;
    if (start + f.footprint > MAX_CHANNEL + 1) return null;
    const origin = this.conflictsAt(f.universe, f.start, f.footprint, id);
    const target =
      universe === f.universe && start === f.start
        ? origin.slice()
        : this.conflictsAt(universe, start, f.footprint, id);
    return {
      fixture: { ...f },
      targetUniverse: universe,
      targetStart: start,
      origin,
      target,
      canCommit: target.length === 0,
    };
  }

  /**
   * 提交移动：仅当目标位直接冲突列表为空时生效，并重算受影响 universe 的
   * 冲突组；否则补丁保持不变。返回提交时的试移结果。成功写回使引擎修订 +1。
   */
  commit(id: string, universe: number, start: number): TrialResult | null {
    const trial = this.trialMove(id, universe, start);
    if (!trial || !trial.canCommit) return trial;
    const f = this.fixtures.get(id)!;
    const oldUniverse = f.universe;
    const oldArr = this.byUniverse.get(oldUniverse)!;
    oldArr.splice(this.lowerBound(oldArr, f.start, f.id), 1);
    f.universe = universe;
    f.start = start;
    let newArr = this.byUniverse.get(universe);
    if (!newArr) {
      newArr = [];
      this.byUniverse.set(universe, newArr);
    }
    newArr.splice(this.lowerBound(newArr, f.start, f.id), 0, f);
    if (oldArr.length === 0) {
      this.byUniverse.delete(oldUniverse);
      this.groupsByUniverse.delete(oldUniverse);
    } else {
      this.groupsByUniverse.set(oldUniverse, this.sweep(oldUniverse, oldArr));
    }
    this.groupsByUniverse.set(universe, this.sweep(universe, newArr));
    this.rev += 1;
    return trial;
  }

  /**
   * 双灯具原子互换预演：按逐字节精确的两个不同 id 选灯，互换各自 universe 与
   * 起始通道，footprint 仍随原灯具。所有核验都在“两灯同时落到新位置”的完整
   * 候选补丁口径上一次性完成——通道上界、两灯相互重叠、以及与其他灯具的新增
   * 冲突，绝不以逐盏试移的临时状态（对方仍占着目标通道）作结论。
   *
   * id 之一不存在或两者逐字节相同返回 null（非法请求，调用方只提示，不改状态）。
   */
  previewSwap(idA: string, idB: string): SwapPreview | null {
    if (idA === idB) return null;
    const a = this.fixtures.get(idA);
    const b = this.fixtures.get(idB);
    if (!a || !b) return null;
    const revision = this.rev;

    // 通道上界：footprint 随原灯具，仅换 universe/start（对方当前位置必在合法域）。
    const aBounds =
      isValidUniverse(b.universe) &&
      isIntBetween(b.start, MIN_CHANNEL, MAX_CHANNEL) &&
      b.start + a.footprint <= MAX_CHANNEL + 1;
    const bBounds =
      isValidUniverse(a.universe) &&
      isIntBetween(a.start, MIN_CHANNEL, MAX_CHANNEL) &&
      a.start + b.footprint <= MAX_CHANNEL + 1;

    // 两灯在候选位置上是否相互重叠（与该对在原补丁中是否冲突无关：无条件拒绝）。
    const mutualOverlap = this.overlapsAt(
      b.universe,
      b.start,
      a.footprint,
      a.universe,
      a.start,
      b.footprint,
    );

    // 原位直接冲突（当前补丁口径，含对方）。
    const aOrigin = this.conflictsAt(a.universe, a.start, a.footprint, idA);
    const bOrigin = this.conflictsAt(b.universe, b.start, b.footprint, idB);

    // 目标位直接冲突（完整候选补丁口径）：与“其他灯具”的关系通过只读索引查询
    // 并排除互换双方（双方此刻都不在原位）；两灯彼此关系由 mutualOverlap 单独给出。
    const aTargetOthers = this.conflictsAt(b.universe, b.start, a.footprint, idA, idB);
    const bTargetOthers = this.conflictsAt(a.universe, a.start, b.footprint, idB, idA);
    const aTarget = mutualOverlap ? this.mergeSorted(aTargetOthers, idB) : aTargetOthers;
    const bTarget = mutualOverlap ? this.mergeSorted(bTargetOthers, idA) : bTargetOthers;

    // 候选冲突变化：目标位（候选口径）相对原位的新增/消解，均按 UTF-8 字节序。
    // 新增中对“其他灯具”的部分决定合法性；对“对方”的新增已由 mutualOverlap 兜住。
    const aAdded = aTarget.filter((id) => !aOrigin.includes(id));
    const bAdded = bTarget.filter((id) => !bOrigin.includes(id));
    const aRemoved = aOrigin.filter((id) => !aTarget.includes(id));
    const bRemoved = bOrigin.filter((id) => !bTarget.includes(id));

    const canCommit =
      aBounds && bBounds && !mutualOverlap && aAdded.length === 0 && bAdded.length === 0;

    const makeSide = (
      f: Fixture,
      targetUniverse: number,
      targetStart: number,
      inBounds: boolean,
      origin: string[],
      target: string[],
      added: string[],
      removed: string[],
    ): SwapSide => ({
      fixture: { ...f },
      targetUniverse,
      targetStart,
      inBounds,
      origin,
      target,
      added,
      removed,
    });

    return {
      revision,
      a: makeSide(a, b.universe, b.start, aBounds, aOrigin, aTarget, aAdded, aRemoved),
      b: makeSide(b, a.universe, a.start, bBounds, bOrigin, bTarget, bAdded, bRemoved),
      mutualOverlap,
      canCommit,
    };
  }

  /**
   * 原子互换提交：仅当预演修订仍是当前修订、且在当前补丁上重新预演仍可提交时
   * 一次生效。过期（任何成功写回都会推进修订）返回 stale 且不改变任何状态；
   * 当前核验未过返回 rejected，补丁、冲突组同样保持不变。
   */
  commitSwap(preview: SwapPreview): SwapCommitResult {
    if (preview.revision !== this.rev) return { status: "stale", preview: null };
    const idA = preview.a.fixture.id;
    const idB = preview.b.fixture.id;
    const fresh = this.previewSwap(idA, idB);
    if (!fresh || !fresh.canCommit) {
      return { status: "rejected", preview: fresh };
    }

    const a = this.fixtures.get(idA)!;
    const b = this.fixtures.get(idB)!;
    const affected = new Set<number>([a.universe, b.universe, fresh.a.targetUniverse]);
    // 先从原有序数组摘除（两灯在同一 universe 时各自按当前数组重算下界）。
    const aOldArr = this.byUniverse.get(a.universe)!;
    aOldArr.splice(this.lowerBound(aOldArr, a.start, a.id), 1);
    const bOldArr = this.byUniverse.get(b.universe)!;
    bOldArr.splice(this.lowerBound(bOldArr, b.start, b.id), 1);
    for (const u of affected) {
      const arr = this.byUniverse.get(u);
      if (arr && arr.length === 0) {
        this.byUniverse.delete(u);
        this.groupsByUniverse.delete(u);
      }
    }
    // 同时落到对方的 universe/start（footprint 不变）。
    const aNewUniverse = fresh.a.targetUniverse;
    const aNewStart = fresh.a.targetStart;
    const bNewUniverse = fresh.b.targetUniverse;
    const bNewStart = fresh.b.targetStart;
    a.universe = aNewUniverse;
    a.start = aNewStart;
    b.universe = bNewUniverse;
    b.start = bNewStart;
    const insert = (f: Fixture) => {
      let arr = this.byUniverse.get(f.universe);
      if (!arr) {
        arr = [];
        this.byUniverse.set(f.universe, arr);
      }
      arr.splice(this.lowerBound(arr, f.start, f.id), 0, f);
    };
    insert(a);
    insert(b);
    for (const u of affected) {
      const arr = this.byUniverse.get(u);
      if (arr) this.groupsByUniverse.set(u, this.sweep(u, arr));
      else this.groupsByUniverse.delete(u);
    }
    this.rev += 1;
    return { status: "committed", preview: this.previewSwap(idA, idB) };
  }

  /** 把单个 id 按 UTF-8 字节序并入已排序 id 列表（用于补入相互重叠的对方）。 */
  private mergeSorted(sorted: string[], id: string): string[] {
    const idB = this.idBytes.get(id)!;
    const out: string[] = [];
    let inserted = false;
    for (const x of sorted) {
      if (!inserted && compareBytes(this.idBytes.get(x)!, idB) > 0) {
        out.push(id);
        inserted = true;
      }
      out.push(x);
    }
    if (!inserted) out.push(id);
    return out;
  }

  /** 两个闭区间（可在不同 universe）是否相交：同 universe 且端点相接即相交。 */
  private overlapsAt(
    u1: number,
    s1: number,
    fp1: number,
    u2: number,
    s2: number,
    fp2: number,
  ): boolean {
    return u1 === u2 && s1 <= s2 + fp2 - 1 && s2 <= s1 + fp1 - 1;
  }

  /** (start, id 字节序) 有序数组中的下界位置。 */
  private lowerBound(arr: Fixture[], start: number, id: string): number {
    const idB = this.idBytes.get(id)!;
    let a = 0;
    let b = arr.length;
    while (a < b) {
      const m = (a + b) >> 1;
      const c = arr[m].start - start || compareBytes(this.idBytes.get(arr[m].id)!, idB);
      if (c < 0) a = m + 1;
      else b = m;
    }
    return a;
  }
}
