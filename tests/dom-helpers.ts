/**
 * Obsidian patches a set of DOM helpers onto Element/HTMLElement at runtime
 * (`createDiv`, `empty`, `setText`, `toggleClass`, `hide`, …). The plugin uses
 * them the way any Obsidian plugin does, so the mock has to provide them too —
 * otherwise a panel test fails on helpers that exist perfectly well in the app.
 */

interface CreateOptions {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string>;
  title?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  href?: string;
}

type El = HTMLElement & {
  createEl?: (tag: string, o?: CreateOptions, cb?: (el: El) => void) => El;
  createDiv?: (o?: CreateOptions, cb?: (el: El) => void) => El;
  createSpan?: (o?: CreateOptions, cb?: (el: El) => void) => El;
  empty?: () => void;
  setText?: (text: string | DocumentFragment) => void;
  addClass?: (...classes: string[]) => void;
  removeClass?: (...classes: string[]) => void;
  toggleClass?: (classes: string | string[], value: boolean) => void;
  hasClass?: (cls: string) => boolean;
  setAttr?: (name: string, value: string | number | boolean | null) => void;
  detach?: () => void;
  show?: () => void;
  hide?: () => void;
  toggle?: (show: boolean) => void;
  appendText?: (text: string) => void;
};

function applyOptions(el: El, o: CreateOptions = {}): El {
  if (o.cls) {
    const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/);
    for (const cls of classes) if (cls) el.classList.add(cls);
  }
  if (o.text !== undefined) el.textContent = o.text;
  if (o.title) el.title = o.title;
  if (o.type && "type" in el) (el as HTMLInputElement).type = o.type;
  if (o.placeholder && "placeholder" in el) (el as HTMLInputElement).placeholder = o.placeholder;
  if (o.value && "value" in el) (el as HTMLInputElement).value = o.value;
  if (o.href && "href" in el) (el as HTMLAnchorElement).href = o.href;
  for (const [name, value] of Object.entries(o.attr ?? {})) el.setAttribute(name, value);
  return el;
}

export function installDomHelpers(): void {
  const proto = Element.prototype as any;
  const element = Element.prototype as any;

  const helpers: Record<string, (...args: any[]) => any> = {
    createEl(this: El, tag: string, o?: CreateOptions, cb?: (el: El) => void): El {
      // This shim *is* createEl, so it has to go through the DOM directly.
      const el = document.createElement(tag) as El;
      applyOptions(el, o);
      element.appendChild.call(this, el);
      cb?.(el);
      return el;
    },
    createDiv(this: El, o?: CreateOptions, cb?: (el: El) => void): El {
      return helpers.createEl.call(this, "div", o, cb);
    },
    createSpan(this: El, o?: CreateOptions, cb?: (el: El) => void): El {
      return helpers.createEl.call(this, "span", o, cb);
    },
    empty(this: El): void {
      while (this.firstChild) element.removeChild.call(this, this.firstChild);
    },
    setText(this: El, value: string | DocumentFragment): void {
      helpers.empty.call(this);
      element.appendChild.call(this, typeof value === "string" ? document.createTextNode(value) : value);
    },
    appendText(this: El, value: string): void {
      element.appendChild.call(this, document.createTextNode(value));
    },
    addClass(this: El, ...classes: string[]): void {
      for (const cls of classes) this.classList.add(cls);
    },
    removeClass(this: El, ...classes: string[]): void {
      for (const cls of classes) this.classList.remove(cls);
    },
    toggleClass(this: El, classes: string | string[], value: boolean): void {
      for (const cls of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(cls, value);
    },
    hasClass(this: El, cls: string): boolean {
      return this.classList.contains(cls);
    },
    setAttr(this: El, name: string, value: string | number | boolean | null): void {
      if (value === null || value === false) this.removeAttribute(name);
      else this.setAttribute(name, String(value));
    },
    detach(this: El): void {
      this.remove();
    },
    // Obsidian's own element helpers; the panel uses setCssStyles to size the
    // composer, so the mock needs it to keep the transcript tests honest.
    setCssStyles(this: El, styles: Record<string, string>): void {
      Object.assign(this.style, styles);
    },
    setCssProps(this: El, props: Record<string, string>): void {
      for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
    },
    show(this: El): void {
      this.setCssProps({ display: "" });
    },
    hide(this: El): void {
      this.setCssProps({ display: "none" });
    },
    toggle(this: El, show: boolean): void {
      this.style.display = show ? "" : "none";
    },
  };

  for (const [name, fn] of Object.entries(helpers)) {
    if (typeof proto[name] !== "function") proto[name] = fn;
  }
}

installDomHelpers();
