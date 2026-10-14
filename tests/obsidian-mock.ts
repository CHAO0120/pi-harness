import "./dom-helpers";

/**
 * Minimal stand-in for the `obsidian` module: just the surface this plugin
 * touches. Everything else (WebSocket, JSON, the relay) stays real, so a
 * panel test can exercise DOM + transport without Obsidian itself.
 */

export class Component {
  registerEvent(): void {}
  registerDomEvent(): void {}
  registerInterval(): number {
    return 0;
  }
}

export class ItemView extends Component {
  contentEl: HTMLElement = document.createElement("div");
  containerEl: HTMLElement = this.contentEl;
  app: unknown = null;
  icon = "";

  constructor(public leaf: unknown) {
    super();
  }

  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class TFile {
  path = "";
  name = "";
  extension = "md";
}

export interface MockEditor {
  getSelection(): string;
  replaceSelection(text: string): void;
}

export class MarkdownView extends ItemView {
  editor: MockEditor = {
    getSelection: () => "",
    replaceSelection: (_text: string) => undefined,
  };
  file: TFile | null = null;
}

export class WorkspaceLeaf extends Component {}

export class Plugin extends Component {
  manifest = { version: "test" };
  constructor(
    public app: unknown,
    manifest: unknown = {},
  ) {
    super();
    Object.assign(this.manifest, manifest as object);
  }
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): HTMLElement {
    return document.createElement("div");
  }
  addCommand(): void {}
  addSettingTab(): void {}
  registerView(): void {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(): Promise<void> {}
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement("div");
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
  display(): void {}
}

interface Chainable {
  setName(name: string): Chainable;
  setDesc(desc: string): Chainable;
  addText(cb: (text: unknown) => unknown): Chainable;
  addTextArea(cb: (text: unknown) => unknown): Chainable;
  addToggle(cb: (toggle: unknown) => unknown): Chainable;
  addButton(cb: (button: unknown) => unknown): Chainable;
  addDropdown(cb: (dropdown: unknown) => unknown): Chainable;
  then(cb: (setting: Chainable) => unknown): Chainable;
}

export class Setting implements Chainable {
  constructor(public containerEl: HTMLElement) {}
  setName(): Chainable {
    return this;
  }
  setDesc(): Chainable {
    return this;
  }
  addText(cb: (text: unknown) => unknown): Chainable {
    cb({ inputEl: document.createElement("input"), setValue: () => text(), onChange: () => text() });
    return this;
  }
  addTextArea(cb: (text: unknown) => unknown): Chainable {
    return this.addText(cb);
  }
  addToggle(cb: (toggle: unknown) => unknown): Chainable {
    cb({ setValue: () => toggle(), onChange: () => toggle() });
    return this;
  }
  addButton(cb: (button: unknown) => unknown): Chainable {
    cb({ setButtonText: () => button(), setDisabled: () => button(), onClick: () => button() });
    return this;
  }
  addDropdown(cb: (dropdown: unknown) => unknown): Chainable {
    cb({ addOption: () => dropdown(), setValue: () => dropdown(), onChange: () => dropdown() });
    return this;
  }
  then(cb: (setting: Chainable) => unknown): Chainable {
    cb(this);
    return this;
  }
}

const text = (): Chainable => new Setting(document.createElement("div"));
const toggle = (): Chainable => new Setting(document.createElement("div"));
const button = (): Chainable => new Setting(document.createElement("div"));
const dropdown = (): Chainable => new Setting(document.createElement("div"));

export class Menu {
  items: { title: string; checked: boolean }[] = [];
  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem(this);
    cb(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(): void {}
}

export class MenuItem {
  title = "";
  checked = false;
  constructor(private readonly menu: Menu) {}
  setTitle(title: string): this {
    this.title = title;
    this.menu.items.push({ title, checked: this.checked });
    return this;
  }
  setIsLabel(): this {
    return this;
  }
  setChecked(checked: boolean): this {
    this.checked = checked;
    return this;
  }
  setDisabled(): this {
    return this;
  }
  onClick(): this {
    return this;
  }
}

export const notices: string[] = [];

export class App {}

export class FuzzySuggestModal<T> {
  constructor(readonly app: App) {}
  setPlaceholder(_text: string): void {}
  open(): void {}
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T): void {}
}

export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

export const MarkdownRenderer = {
  render: async (_app: unknown, markdown: string, el: HTMLElement): Promise<void> => {
    el.createDiv({ text: markdown });
  },
};

export const Platform = { isMobile: true, isDesktop: false, isPhone: true };

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
}

export function normalizePath(path: string): string {
  return path;
}
