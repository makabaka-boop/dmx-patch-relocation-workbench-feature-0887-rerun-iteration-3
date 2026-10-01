// @vitest-environment happy-dom
/**
 * 验收：双灯具原子互换的界面行为。
 *
 * 覆盖：
 * - 预演展示两灯原位、目标位置与候选冲突变化（原位/目标位冲突列表、相互重叠、新增冲突对）；
 * - 提交成功：补丁、冲突组、试移面板、复核状态与下载导出落到同一新快照；
 * - 候选不合法：提交被禁止，补丁、冲突组与既有复核结论不变；
 * - 预演过期（期间发生单灯提交）：提交入口消失并要求重新预演，重新预演后方可提交；
 * - 两个 id 输入逐字节匹配：形近 id 各自命中，相同 id / 不存在的 id 只报错不改状态。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { Fixture, parsePatch } from "../lib/dmx";

afterEach(() => cleanup());

/* ---------------------------------------------------------------------- */
/* 补丁与界面辅助                                                          */
/* ---------------------------------------------------------------------- */

/**
 * 成功场景补丁：
 * - A1 u1[1,4] 与 A2 u1[4,7] 端点相接成组；
 * - B1 u2[10,12]（fp3）与二者均不冲突；
 * 互换 A1(fp4)↔B1(fp3)：A1→u2[10,13]，B1→u1[1,3]（与 A2[4,7] 不相交）⇒ 合法。
 */
const SWAP_PATCH: Fixture[] = [
  { id: "A1", universe: 1, start: 1, footprint: 4 },
  { id: "A2", universe: 1, start: 4, footprint: 4 },
  { id: "B1", universe: 2, start: 10, footprint: 3 },
];

/** 阻断场景补丁：B1(fp4) 换到 u1[1,4] 会撞 A2[3,6]，产生新增对 (B1,A2)。 */
const BLOCKED_PATCH: Fixture[] = [
  { id: "A1", universe: 1, start: 1, footprint: 4 },
  { id: "A2", universe: 1, start: 3, footprint: 4 },
  { id: "B1", universe: 2, start: 10, footprint: 4 },
];

function jsonFile(patch: unknown, name = "patch.json"): File {
  return new File([JSON.stringify(patch)], name, { type: "application/json" });
}

type View = ReturnType<typeof render>;

async function importPatch(view: View, patch: Fixture[]) {
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, jsonFile(patch));
  await view.findByText(new RegExp(`已导入 ${patch.length} 具灯具`));
}

function swapInputs(view: View): [HTMLInputElement, HTMLInputElement] {
  return [
    view.getByRole("textbox", { name: "灯具 A id" }) as HTMLInputElement,
    view.getByRole("textbox", { name: "灯具 B id" }) as HTMLInputElement,
  ];
}

async function typeSwapIds(view: View, a: string, b: string) {
  const [inputA, inputB] = swapInputs(view);
  await userEvent.clear(inputA);
  if (a) await userEvent.type(inputA, a);
  await userEvent.clear(inputB);
  if (b) await userEvent.type(inputB, b);
}

async function runPreview(view: View) {
  fireEvent.click(view.getByRole("button", { name: "预演互换" }));
}

function groupChipIds(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("ol.group-list li.group")].map((li) =>
    [...li.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!),
  );
}

/** 互换预演中四个冲突列表各自的 chip data-id。 */
function swapLists(container: HTMLElement): string[][] {
  return [...container.querySelectorAll(".swap-preview .lists > div")].map((block) =>
    [...block.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!),
  );
}

function swapRow(container: HTMLElement, testid: string): HTMLElement {
  return container.querySelector(`[data-testid="${testid}"]`)!.closest("tr")!;
}

function commitButton(view: View): HTMLButtonElement | null {
  return view.queryByRole("button", { name: "提交原子互换" }) as HTMLButtonElement | null;
}

function reviewSection(container: HTMLElement): HTMLElement {
  return container.querySelector("section.review") as HTMLElement;
}

async function uploadCandidate(view: View, patch: Fixture[]) {
  const inputs = view.container.querySelectorAll('input[type="file"]');
  await userEvent.upload(inputs[1] as HTMLInputElement, jsonFile(patch, "candidate.json"));
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Response(blob).text();
}

/* ---------------------------------------------------------------------- */
/* 预演展示与提交成功                                                      */
/* ---------------------------------------------------------------------- */

describe("验收（互换）：预演展示与提交成功", () => {
  it("预演展示两灯原位、目标位与冲突变化；提交后页面落到同一新快照", async () => {
    const view = render(<App />);
    await importPatch(view, SWAP_PATCH);
    expect(groupChipIds(view.container)).toEqual([["A1", "A2"]]);

    // 先选中 B1：提交互换后试移面板应随之刷新到新位置
    const lookup = view.getByRole("textbox", { name: "按 id 查找灯具" });
    await userEvent.type(lookup, "B1");
    fireEvent.click(view.getByRole("button", { name: "选择" }));

    await typeSwapIds(view, "A1", "B1");
    await runPreview(view);

    // 两灯原位与目标位（footprint 仍随原灯具）
    const rowA = swapRow(view.container, "swap-a-id");
    expect(rowA.textContent).toContain("u1 · 1–4（fp 4）"); // A1 原位
    expect(rowA.textContent).toContain("u2 · 10–13（fp 4）"); // A1 目标位
    const rowB = swapRow(view.container, "swap-b-id");
    expect(rowB.textContent).toContain("u2 · 10–12（fp 3）"); // B1 原位
    expect(rowB.textContent).toContain("u1 · 1–3（fp 3）"); // B1 目标位

    // 候选冲突变化：A1 原位冲突 [A2]，目标位空；B1 原位/目标位均空
    const [aOrigin, aTarget, bOrigin, bTarget] = swapLists(view.container);
    expect(aOrigin).toEqual(["A2"]);
    expect(aTarget).toEqual([]);
    expect(bOrigin).toEqual([]);
    expect(bTarget).toEqual([]);
    expect(view.container.textContent).toContain("互换后两灯互不重叠。");
    expect(view.container.textContent).toContain("无新增冲突对。");
    expect(view.container.textContent).toContain("候选补丁合法，可原子提交。");

    // 提交：一次生效
    fireEvent.click(commitButton(view)!);
    const banner = await within(view.container).findByText(/已原子互换/);
    const bannerIds = [...banner.querySelectorAll(".id-text")].map((s) => s.textContent);
    expect(bannerIds).toEqual(["A1", "B1"]);

    // 冲突组重算：B1[1,3] 与 A2[4,7] 不相交，原组消失
    expect(view.container.textContent).toContain("冲突组（0）");
    expect(groupChipIds(view.container)).toEqual([]);

    // 试移面板刷新到 B1 的新位置（u1 [1,3]，fp 仍是 3）
    const dds = [...view.container.querySelectorAll("dl.fixture dd")].map((d) => d.textContent);
    expect(dds).toContain("1"); // universe
    expect(dds).toContain("3"); // footprint
    expect(view.container.textContent).toContain("[1, 3]");
  });

  it("成功后既有候选复核被撤销；复核与下载导出对应同一新快照", async () => {
    const view = render(<App />);
    await importPatch(view, SWAP_PATCH);

    // 先做一次复核：候选把 A1 挪到 u3 ⇒ 1 项提案被采纳
    const candidate = [
      { id: "A1", universe: 3, start: 1, footprint: 4 },
      { id: "A2", universe: 1, start: 4, footprint: 4 },
      { id: "B1", universe: 2, start: 10, footprint: 3 },
    ];
    await uploadCandidate(view, candidate);
    await view.findByText(/共 1 项提案/);
    expect(
      [...reviewSection(view.container).querySelectorAll("[data-adopted-id]")].map((li) =>
        li.getAttribute("data-adopted-id"),
      ),
    ).toEqual(["A1"]);

    // 原子互换 A1↔B1 成功：既有复核结论立即撤销、下载禁用
    await typeSwapIds(view, "A1", "B1");
    await runPreview(view);
    fireEvent.click(commitButton(view)!);
    await within(view.container).findByText(/已原子互换/);
    const review = reviewSection(view.container);
    expect(review.querySelector("[data-adopted-id]")).toBeNull();
    expect(
      (view.getByRole("button", { name: "下载合并结果 JSON" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // 重新上传同一候选：复核基于新快照——A1(u2[10,13])与 B1(u1[1,3]) 都成了提案
    await uploadCandidate(view, candidate);
    const banner = await view.findByText(/共 2 项提案/);
    expect(banner.textContent).toContain("采纳 2 项");

    // 下载导出与新快照一致：A1→u3[1,4]、B1→u2[10,12]、A2 不动
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return "blob:mock";
      },
      revokeObjectURL: () => undefined,
    });
    try {
      fireEvent.click(view.getByRole("button", { name: "下载合并结果 JSON" }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(blobs).toHaveLength(1);
    const exported = parsePatch(JSON.parse(await blobText(blobs[0])));
    expect(exported).toEqual([
      { id: "A1", universe: 3, start: 1, footprint: 4 },
      { id: "A2", universe: 1, start: 4, footprint: 4 },
      { id: "B1", universe: 2, start: 10, footprint: 3 },
    ]);
  });
});

/* ---------------------------------------------------------------------- */
/* 候选不合法：补丁、冲突组与复核结论不变                                   */
/* ---------------------------------------------------------------------- */

describe("验收（互换）：候选不合法", () => {
  it("新增冲突对在预演中标出，提交入口不出现，补丁与既有复核结论不变", async () => {
    const view = render(<App />);
    await importPatch(view, BLOCKED_PATCH);
    expect(groupChipIds(view.container)).toEqual([["A1", "A2"]]);

    // 先形成一份复核结论：拒绝期间它不得被动摇
    const candidate = [
      { id: "A1", universe: 1, start: 1, footprint: 4 },
      { id: "A2", universe: 1, start: 3, footprint: 4 },
      { id: "B1", universe: 3, start: 10, footprint: 4 },
    ];
    await uploadCandidate(view, candidate);
    await view.findByText(/采纳 1 项/);

    await typeSwapIds(view, "A1", "B1");
    await runPreview(view);

    // B1→u1[1,4] 撞 A2[3,6]：新增冲突对 (B1,A2) 标出，提交被禁止
    const pairs = [...view.container.querySelectorAll("[data-swap-pair]")].map((li) =>
      li.getAttribute("data-swap-pair"),
    );
    expect(pairs).toEqual(["B1⇔A2"]);
    expect(view.container.textContent).toContain("新增冲突对（1）");
    const blocked = view.container.querySelector('[data-testid="swap-blocked"]')!;
    expect(blocked.textContent).toContain("新增 1 对冲突");
    expect(commitButton(view)).toBeNull();

    // 补丁、冲突组与既有复核结论均不变
    expect(groupChipIds(view.container)).toEqual([["A1", "A2"]]);
    expect(view.container.textContent).toContain("冲突组（1）");
    expect(
      [...reviewSection(view.container).querySelectorAll("[data-adopted-id]")].map((li) =>
        li.getAttribute("data-adopted-id"),
      ),
    ).toEqual(["B1"]);
  });

  it("footprint 较大者换到高起始通道越界：预演标出上界越界", async () => {
    const view = render(<App />);
    await importPatch(view, [
      { id: "wide", universe: 1, start: 1, footprint: 10 },
      { id: "high", universe: 2, start: 510, footprint: 3 },
    ]);
    await typeSwapIds(view, "wide", "high");
    await runPreview(view);
    const rowA = swapRow(view.container, "swap-a-id");
    expect(rowA.textContent).toContain("u2 · 510–519（fp 10）");
    expect(rowA.textContent).toContain("越界");
    expect(view.container.querySelector('[data-testid="swap-blocked"]')!.textContent).toContain(
      "通道上界越界",
    );
    expect(commitButton(view)).toBeNull();
  });
});

/* ---------------------------------------------------------------------- */
/* 预演过期：须重新预演                                                    */
/* ---------------------------------------------------------------------- */

describe("验收（互换）：预演过期", () => {
  it("预演后发生单灯提交：预演标记过期、提交入口消失，重新预演后方可提交", async () => {
    const view = render(<App />);
    await importPatch(view, [
      { id: "A1", universe: 1, start: 1, footprint: 4 },
      { id: "B1", universe: 2, start: 10, footprint: 3 },
      { id: "C1", universe: 3, start: 1, footprint: 4 },
    ]);

    // 互换预演（合法）
    await typeSwapIds(view, "A1", "B1");
    await runPreview(view);
    expect(commitButton(view)).not.toBeNull();

    // 期间发生一次无关的单灯提交：C1 → u9[100,103]
    const lookup = view.getByRole("textbox", { name: "按 id 查找灯具" });
    await userEvent.type(lookup, "C1");
    fireEvent.click(view.getByRole("button", { name: "选择" }));
    const [uniInput, startInput] = [
      ...view.container.querySelectorAll(".inputs input"),
    ] as HTMLInputElement[];
    await userEvent.clear(uniInput);
    await userEvent.type(uniInput, "9");
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "100");
    fireEvent.click(view.getByRole("button", { name: "试移" }));
    fireEvent.click(view.getByRole("button", { name: "提交移动" }));
    await within(view.container).findByText(/已提交/);

    // 旧预演已过期：提示重新预演，提交入口消失
    expect(view.container.querySelector('[data-testid="swap-stale"]')).not.toBeNull();
    expect(commitButton(view)).toBeNull();

    // 重新预演后提交成功；补丁恰好反映一次互换 + 一次单灯提交
    await runPreview(view);
    expect(view.container.querySelector('[data-testid="swap-stale"]')).toBeNull();
    fireEvent.click(commitButton(view)!);
    await within(view.container).findByText(/已原子互换/);

    const lookup2 = view.getByRole("textbox", { name: "按 id 查找灯具" }) as HTMLInputElement;
    await userEvent.clear(lookup2);
    await userEvent.type(lookup2, "A1");
    fireEvent.click(view.getByRole("button", { name: "选择" }));
    let dds = [...view.container.querySelectorAll("dl.fixture dd")].map((d) => d.textContent);
    expect(dds).toContain("2"); // A1 已在 u2
    expect(view.container.textContent).toContain("[10, 13]");

    await userEvent.clear(lookup2);
    await userEvent.type(lookup2, "B1");
    fireEvent.click(view.getByRole("button", { name: "选择" }));
    dds = [...view.container.querySelectorAll("dl.fixture dd")].map((d) => d.textContent);
    expect(dds).toContain("1"); // B1 已在 u1
    expect(view.container.textContent).toContain("[1, 3]");
  });
});

/* ---------------------------------------------------------------------- */
/* 逐字节 id 输入                                                          */
/* ---------------------------------------------------------------------- */

describe("验收（互换）：逐字节 id 输入", () => {
  it("前导空格 id 与无形近 id 各自精确命中", async () => {
    const view = render(<App />);
    await importPatch(view, [
      { id: " A", universe: 1, start: 1, footprint: 2 },
      { id: "A", universe: 2, start: 5, footprint: 2 },
    ]);
    await typeSwapIds(view, " A", "A");
    await runPreview(view);
    // 预演选中的正是 " A"（u1）与 "A"（u2）两具不同灯具
    expect(
      view.container.querySelector('[data-testid="swap-a-id"] .id-text')!.textContent,
    ).toBe(" A");
    expect(
      view.container.querySelector('[data-testid="swap-b-id"] .id-text')!.textContent,
    ).toBe("A");
    const rowA = swapRow(view.container, "swap-a-id");
    expect(rowA.textContent).toContain("u1 · 1–2（fp 2）");
    expect(rowA.textContent).toContain("u2 · 5–6（fp 2）");
    fireEvent.click(commitButton(view)!);
    const banner = await within(view.container).findByText(/已原子互换/);
    const ids = [...banner.querySelectorAll(".id-text")].map((s) => s.textContent);
    expect(ids).toEqual([" A", "A"]);
  });

  it("两个 id 相同或不存在：只报错，不产生预演、不改补丁", async () => {
    const view = render(<App />);
    await importPatch(view, [
      { id: "A", universe: 1, start: 1, footprint: 2 },
      { id: "B", universe: 2, start: 1, footprint: 2 },
    ]);

    // 相同 id
    await typeSwapIds(view, "A", "A");
    await runPreview(view);
    expect(view.container.textContent).toContain("互换预演失败");
    expect(view.container.querySelector(".swap-preview")).toBeNull();

    // 不存在的 id（尾随空格是另一具灯具，逐字节不匹配）
    await typeSwapIds(view, "A ", "B");
    await runPreview(view);
    expect(view.container.textContent).toContain("互换预演失败");
    expect(view.container.querySelector(".swap-preview")).toBeNull();

    // 补丁未变
    expect(view.container.textContent).toContain("2 具灯具");
  });
});
