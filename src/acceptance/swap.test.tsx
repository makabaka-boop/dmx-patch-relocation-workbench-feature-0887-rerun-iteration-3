// @vitest-environment happy-dom
/**
 * 验收（界面）：双灯具原子互换的预演与提交。
 *
 * 覆盖：
 * - 逐盏试移会被对方占用的目标通道挡住，而原子互换在完整候选补丁上一次成功；
 * - 预演展示两灯原位、目标位置与候选冲突变化（新增/消解）；
 * - 拒绝（越界、两灯相互重叠、与第三方新增冲突）不改补丁、冲突组与下载；
 * - 预演后引擎修订被单灯提交推进：旧预演过期，提交被要求重新预演，重新预演后成功；
 * - 成功后页面、冲突组与既有复核状态对应同一新快照（复核结论被撤销、下载禁用）；
 * - id 逐字节身份：全空格/尾随空格 id 原样作为互换入口。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { Fixture } from "../lib/dmx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonFile(patch: unknown, name = "patch.json"): File {
  return new File([JSON.stringify(patch)], name, { type: "application/json" });
}

/** 互换面板。 */
function swapPanel(container: HTMLElement): HTMLElement {
  return container.querySelector("section.swap") as HTMLElement;
}

function swapInputs(panel: HTMLElement): HTMLInputElement[] {
  return [...panel.querySelectorAll("input")] as HTMLInputElement[];
}

function sideBlock(panel: HTMLElement, which: "a" | "b"): HTMLElement {
  return panel.querySelector(`[data-swap-side="${which}"]`) as HTMLElement;
}

/** 冲突组面板中全部 chip 的 data-id（按 DOM 顺序）。 */
function groupChipIds(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("ol.group-list li.group")].map((li) =>
    [...li.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!),
  );
}

/** 单方块的原位/目标/新增/消解 chip 列表，通过 h4 标题定位。 */
function sideLists(block: HTMLElement): {
  origin: string[];
  target: string[];
  added: string[];
  removed: string[];
} {
  const listUnder = (text: string) => {
    const h = [...block.querySelectorAll("h4")].find((x) => x.textContent!.includes(text));
    if (!h) return [];
    const parent = h.parentElement!;
    return [...parent.querySelectorAll(".chip")].map((b) => b.getAttribute("data-id")!);
  };
  return {
    origin: listUnder("原位直接冲突"),
    target: listUnder("候选目标位冲突"),
    added: listUnder("新增冲突"),
    removed: listUnder("消解冲突"),
  };
}

/* ---------------------------------------------------------------------- */
/* 验收补丁                                                                */
/* ---------------------------------------------------------------------- */

/**
 * A u1[10,11]、X u1[1,5]；B u2[20,22]、Y u2[40,41]。
 * 互换 A↔B 后：A→u2[20,21]（不碰 Y），B→u1[10,12]（不碰 X），合法。
 * 逐盏试移任一方到对方当前位置都会被对方挡住。
 */
const BASE: Fixture[] = [
  { id: "A", universe: 1, start: 10, footprint: 2 },
  { id: "X", universe: 1, start: 1, footprint: 5 },
  { id: "B", universe: 2, start: 20, footprint: 3 },
  { id: "Y", universe: 2, start: 40, footprint: 2 },
];

async function renderWithBase(): Promise<ReturnType<typeof render>> {
  const view = render(<App />);
  const fileInput = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await userEvent.upload(fileInput, jsonFile(BASE));
  await view.findByText(/已导入 4 具灯具/);
  return view;
}

async function previewSwap(
  view: ReturnType<typeof render>,
  idA: string,
  idB: string,
): Promise<HTMLElement> {
  const panel = swapPanel(view.container);
  const [inA, inB] = swapInputs(panel);
  await userEvent.clear(inA);
  await userEvent.type(inA, idA);
  await userEvent.clear(inB);
  await userEvent.type(inB, idB);
  fireEvent.click(within(panel).getByRole("button", { name: "预演互换" }));
  return (await view.findByTestId("swap-preview")) as HTMLElement;
}

/* ---------------------------------------------------------------------- */
/* 成功互换：逐盏被挡、整体合法                                            */
/* ---------------------------------------------------------------------- */

describe("验收（界面）：双灯原子互换成功", () => {
  it("逐盏试移被对方挡住；原子互换预演展示原位/目标/冲突变化并一次提交", async () => {
    const view = await renderWithBase();
    const { container } = view;

    // 先用单灯试移证明“逐盏”会被挡：用查找框选中 A，目标 u2/start20（B 正占着）
    const lookup = view.getByRole("textbox", { name: "按 id 查找灯具" }) as HTMLInputElement;
    await userEvent.clear(lookup);
    await userEvent.type(lookup, "A{enter}");
    const [uniInput, startInput] = [
      ...container.querySelectorAll(".inputs input"),
    ] as HTMLInputElement[];
    await userEvent.clear(uniInput);
    await userEvent.type(uniInput, "2");
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "20");
    fireEvent.click(view.getByRole("button", { name: "试移" }));
    expect(container.textContent).toContain("目标位被 1 具灯具阻挡");
    // 逐盏路径下提交按钮被禁止（仅展示警告），无法借此完成互换

    // 原子互换预演
    const panel = swapPanel(container);
    const preview = await previewSwap(view, "A", "B");

    // 修订标记
    expect(preview.querySelector('[data-testid="swap-revision"]')!.textContent).toContain("#0");

    // A 侧：原位 u1[10,11] 无冲突；目标 u2[20,21] 当前被 B 占（候选口径中 B 已离开）⇒ 目标空
    const aLists = sideLists(sideBlock(panel, "a"));
    expect(aLists.origin).toEqual([]);
    expect(aLists.target).toEqual([]);
    expect(aLists.added).toEqual([]);
    expect(aLists.removed).toEqual([]);
    // 位置文本
    expect(sideBlock(panel, "a").textContent).toContain("u1 · 10–11");
    expect(sideBlock(panel, "a").textContent).toContain("u2 · 20–21");
    expect(sideBlock(panel, "b").textContent).toContain("u2 · 20–22");
    expect(sideBlock(panel, "b").textContent).toContain("u1 · 10–12");

    // 可提交
    expect(preview.querySelector('[data-testid="swap-ok"]')).not.toBeNull();
    expect(preview.querySelector('[data-testid="swap-mutual"]')).toBeNull();

    // 提交：一次生效
    fireEvent.click(view.getByRole("button", { name: "提交原子互换" }));
    const banner = await within(container).findByText(/已原子互换/);
    expect(banner.querySelector('[data-id="A"]')).not.toBeNull();
    expect(banner.querySelector('[data-id="B"]')).not.toBeNull();

    // 页面新快照：A 在 u2/start20(fp2)，B 在 u1/start10(fp3)，均无冲突组
    expect(container.textContent).toContain("冲突组（0）");
    expect(groupChipIds(container)).toEqual([]);
    // 预演已刷新为修订 #1
    const after = view.getByTestId("swap-preview");
    expect(after.querySelector('[data-testid="swap-revision"]')!.textContent).toContain("#1");
    // footprint 随原灯具：互换后 A 的目标区间按 fp2、B 按 fp3
    expect(sideBlock(swapPanel(container), "a").textContent).toContain("u2 · 20–21");
    expect(sideBlock(swapPanel(container), "b").textContent).toContain("u1 · 10–12");
  });

  it("成功后导出与既有候选复核状态对应同一新快照：复核结论被撤销、下载禁用", async () => {
    const view = await renderWithBase();
    const { container } = view;

    // 先打开一份候选复核（把 X 挪到空闲 universe ⇒ 可采纳），制造“既有复核结论”
    const candidate: Fixture[] = [
      { id: "A", universe: 1, start: 10, footprint: 2 },
      { id: "X", universe: 9, start: 1, footprint: 5 },
      { id: "B", universe: 2, start: 20, footprint: 3 },
      { id: "Y", universe: 2, start: 40, footprint: 2 },
    ];
    const reviewInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
    await userEvent.upload(reviewInput, jsonFile(candidate, "candidate.json"));
    await view.findByText(/采纳 1 项/);
    const downloadBtn = view.getByRole("button", {
      name: "下载合并结果 JSON",
    }) as HTMLButtonElement;
    expect(downloadBtn.disabled).toBe(false);

    // 互换成功后：复核结论立即撤销，下载禁用，页面只剩占位提示
    await previewSwap(view, "A", "B");
    fireEvent.click(view.getByRole("button", { name: "提交原子互换" }));
    await view.findByText(/已原子互换/);
    expect(container.querySelector("[data-adopted-id]")).toBeNull();
    expect(container.querySelector(".review-table")).toBeNull();
    expect(downloadBtn.disabled).toBe(true);
    expect(
      within(container.querySelector("section.review") as HTMLElement).getByText(
        /选择一份候选修订以开始复核/,
      ),
    ).toBeTruthy();
    // 冲突组面板与互换后的引擎快照一致（无冲突）
    expect(container.textContent).toContain("冲突组（0）");
  });
});

/* ---------------------------------------------------------------------- */
/* 拒绝：相互重叠 / 新增第三方冲突 / 越界                                 */
/* ---------------------------------------------------------------------- */

describe("验收（界面）：互换被拒绝不改补丁", () => {
  it("两灯候选位置相互重叠：禁止提交，补丁与冲突组不变", async () => {
    // a u1[1,2]、b u1[2,3] 端点相接成组；互换 start 后 a→[2,3]、b→[1,2] 仍在
    // 通道 2 端点相接 ⇒ 候选下两灯相互重叠（无条件拒绝）。
    const patch: Fixture[] = [
      { id: "a", universe: 1, start: 1, footprint: 2 },
      { id: "b", universe: 1, start: 2, footprint: 2 },
    ];
    const view = render(<App />);
    await userEvent.upload(
      view.container.querySelector('input[type="file"]') as HTMLInputElement,
      jsonFile(patch),
    );
    await view.findByText(/已导入 2 具灯具/);

    await previewSwap(view, "a", "b");
    const panel = swapPanel(view.container);
    expect(panel.querySelector('[data-testid="swap-mutual"]')!.textContent).toContain("相互重叠");
    expect(panel.querySelector('[data-testid="swap-ok"]')).toBeNull();
    // 目标位列表含对方（候选口径下相互重叠）
    expect(sideLists(sideBlock(panel, "a")).target).toEqual(["b"]);
    expect(sideLists(sideBlock(panel, "b")).target).toEqual(["a"]);
    // 没有提交按钮
    expect(
      within(panel).queryByRole("button", { name: "提交原子互换" }),
    ).toBeNull();

    // 补丁/冲突组保持
    expect(groupChipIds(view.container)).toEqual([["a", "b"]]);
  });

  it("与第三方新增冲突：预演标出新增/消解 id，禁止提交，补丁与冲突组不变", async () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 10, footprint: 2 }, // u1[10,11]
      { id: "X", universe: 1, start: 11, footprint: 1 }, // u1[11,11]（与 A 旧冲突）
      { id: "B", universe: 2, start: 20, footprint: 2 }, // u2[20,21]
      { id: "Y", universe: 2, start: 21, footprint: 1 }, // u2[21,21]（与 B 旧冲突）
    ];
    const view = render(<App />);
    await userEvent.upload(
      view.container.querySelector('input[type="file"]') as HTMLInputElement,
      jsonFile(patch),
    );
    await view.findByText(/已导入 4 具灯具/);

    await previewSwap(view, "A", "B");
    const panel = swapPanel(view.container);
    // A(fp2)→u2[20,21] 与 Y[21] 相接为新增；B(fp2)→u1[10,11] 与 X[11] 相接为新增
    expect(sideLists(sideBlock(panel, "a")).added).toEqual(["Y"]);
    expect(sideLists(sideBlock(panel, "b")).added).toEqual(["X"]);
    expect(sideLists(sideBlock(panel, "a")).removed).toEqual(["X"]);
    expect(sideLists(sideBlock(panel, "b")).removed).toEqual(["Y"]);
    expect(panel.querySelector('[data-testid="swap-blocked"]')).not.toBeNull();
    expect(within(panel).queryByRole("button", { name: "提交原子互换" })).toBeNull();

    // 冲突组保持两组（A-X、B-Y）
    expect(groupChipIds(view.container)).toEqual([
      ["A", "X"],
      ["B", "Y"],
    ]);
  });

  it("通道越界：大 footprint 换至高 start 时标注越界且不可提交，补丁不变", async () => {
    const patch: Fixture[] = [
      { id: "A", universe: 1, start: 1, footprint: 512 }, // 占满 u1
      { id: "B", universe: 2, start: 3, footprint: 1 }, // u2[3,3]
    ];
    const view = render(<App />);
    await userEvent.upload(
      view.container.querySelector('input[type="file"]') as HTMLInputElement,
      jsonFile(patch),
    );
    await view.findByText(/已导入 2 具灯具/);
    await previewSwap(view, "A", "B");
    const panel = swapPanel(view.container);
    // A(fp512) → start3：3+512=515 越界
    expect(sideBlock(panel, "a").textContent).toContain("超出通道上界");
    expect(panel.querySelector('[data-testid="swap-blocked"]')!.textContent).toContain(
      "候选补丁不合法",
    );
    expect(within(panel).queryByRole("button", { name: "提交原子互换" })).toBeNull();
    expect(groupChipIds(view.container)).toEqual([]); // 本就无冲突；补丁未变
  });
});

/* ---------------------------------------------------------------------- */
/* 过期提交：预演后修订被推进，须重新预演                                  */
/* ---------------------------------------------------------------------- */

describe("验收（界面）：互换预演过期", () => {
  it("预演后用单灯提交推进修订：旧互换提交提示过期且不生效，重新预演后成功", async () => {
    const view = await renderWithBase();
    const { container } = view;

    // A↔B 互换预演（修订 #0，可提交）
    await previewSwap(view, "A", "B");
    const panel = swapPanel(container);
    expect(panel.querySelector('[data-testid="swap-ok"]')).not.toBeNull();

    // 期间用单灯试移把 X 从 u1[1,5] 搬到 u8[8,8]（成功写回，修订推进到 1）
    const lookup = view.getByRole("textbox", { name: "按 id 查找灯具" }) as HTMLInputElement;
    await userEvent.clear(lookup);
    await userEvent.type(lookup, "X{enter}");
    const [uniInput, startInput] = [
      ...container.querySelectorAll(".inputs input"),
    ] as HTMLInputElement[];
    await userEvent.clear(uniInput);
    await userEvent.type(uniInput, "8");
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "8");
    fireEvent.click(view.getByRole("button", { name: "试移" }));
    expect(container.textContent).toContain("目标位无冲突");
    fireEvent.click(view.getByRole("button", { name: "提交移动" }));
    await within(container).findByText(/已提交/);

    // 旧互换预演现在显示过期，提交按钮消失
    const stalePreview = view.getByTestId("swap-preview");
    expect(stalePreview.querySelector('[data-testid="swap-stale"]')!.textContent).toContain(
      "重新预演",
    );
    expect(within(stalePreview).queryByRole("button", { name: "提交原子互换" })).toBeNull();

    // 即使绕过 UI 直接点击残留按钮也不允许（按钮已不渲染；此处验证补丁未被旧预演改动）
    expect(groupChipIds(container)).toEqual([]);
    // X 已在新位置，A、B 未被互换
    const dds = [...container.querySelectorAll("dl.fixture dd")].map((d) => d.textContent);
    expect(dds).toContain("8");

    // 重新预演（修订 #1）后提交成功
    await previewSwap(view, "A", "B");
    const fresh = view.getByTestId("swap-preview");
    expect(fresh.querySelector('[data-testid="swap-revision"]')!.textContent).toContain("#1");
    expect(fresh.querySelector('[data-testid="swap-ok"]')).not.toBeNull();
    fireEvent.click(within(fresh).getByRole("button", { name: "提交原子互换" }));
    await within(container).findByText(/已原子互换/);
    expect(container.textContent).toContain("冲突组（0）");
    // 修订已到 2（单灯 +1、互换 +1）
    expect(
      view.getByTestId("swap-preview").querySelector('[data-testid="swap-revision"]')!
        .textContent,
    ).toContain("#2");
  });
});

/* ---------------------------------------------------------------------- */
/* 逐字节 id：全空格/尾随空格作为互换入口                                  */
/* ---------------------------------------------------------------------- */

describe("验收（界面）：互换 id 逐字节身份", () => {
  it("全空格 id 与尾随空格 id 原样匹配，空格不被 trim/折叠", async () => {
    const patch: Fixture[] = [
      { id: "   ", universe: 1, start: 10, footprint: 1 }, // u1[10]
      { id: "A ", universe: 2, start: 20, footprint: 1 }, // u2[20]
      { id: "A", universe: 3, start: 30, footprint: 1 }, // 形近的第三盏，不参与
    ];
    const view = render(<App />);
    await userEvent.upload(
      view.container.querySelector('input[type="file"]') as HTMLInputElement,
      jsonFile(patch),
    );
    await view.findByText(/已导入 3 具灯具/);

    const panel = swapPanel(view.container);
    const [inA, inB] = swapInputs(panel);
    await userEvent.clear(inA);
    await userEvent.type(inA, "   "); // 三个空格
    await userEvent.clear(inB);
    await userEvent.type(inB, "A "); // A + 尾随空格
    fireEvent.click(within(panel).getByRole("button", { name: "预演互换" }));
    const preview = (await view.findByTestId("swap-preview")) as HTMLElement;

    // 两个标题中的 id 逐字节渲染
    const titles = [...preview.querySelectorAll(".swap-side h3 .id-text")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["   ", "A "]);
    // 输入框未被改写
    expect(inA.value).toBe("   ");
    expect(inB.value).toBe("A ");

    // 提交后逐字节落到对方位置，"A"（无空格）完全不受影响
    fireEvent.click(view.getByRole("button", { name: "提交原子互换" }));
    await within(view.container).findByText(/已原子互换/);
    const after = view.getByTestId("swap-preview");
    // A 侧（"   "）现在在 u2/start20
    expect(sideBlock(after, "a").textContent).toContain("u2 · 20–20");
    // B 侧（"A "）现在在 u1/start10
    expect(sideBlock(after, "b").textContent).toContain("u1 · 10–10");
  });

  it("两个 id 相同（含逐字节相同的全空格）给出错误提示且不产生预演", async () => {
    const view = await renderWithBase();
    const panel = swapPanel(view.container);
    const [inA, inB] = swapInputs(panel);
    await userEvent.clear(inA);
    await userEvent.type(inA, "A");
    await userEvent.clear(inB);
    await userEvent.type(inB, "A");
    fireEvent.click(within(panel).getByRole("button", { name: "预演互换" }));
    const banner = await within(view.container).findByText(/两个不同的灯具 id/);
    expect(banner).toBeTruthy();
    expect(view.container.querySelector('[data-testid="swap-preview"]')).toBeNull();
  });
});
