/**
 * Encoder-driven modal lists (engine picker, presets, samples, projects, song, help,
 * export). Navigable with the VALUE encoder, arrow keys, or by tapping.
 */
export interface ListItem {
  label: string;
  meta?: string;
  action?: () => void;
  selected?: boolean;
}

export interface DialogModel {
  title: string;
  items: ListItem[];
  hint?: string;
  onSelect?: (index: number) => void;
  onMove?: (index: number) => void;
  onClose?: () => void;
}

export class Dialogs {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private hintEl: HTMLElement;
  model: DialogModel | null = null;
  cursor = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.titleEl = root.querySelector('#overlay-title')!;
    this.listEl = root.querySelector('#overlay-list')!;
    this.hintEl = root.querySelector('#overlay-hint')!;
    this.listEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get open() {
    return this.model !== null;
  }

  show(model: DialogModel, cursor = 0) {
    this.model = model;
    this.cursor = Math.max(0, Math.min(model.items.length - 1, cursor));
    this.render();
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
  }

  close() {
    const cb = this.model?.onClose;
    this.model = null;
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
    cb?.();
  }

  update(model: DialogModel) {
    if (!this.model) return;
    this.model = model;
    this.cursor = Math.max(0, Math.min(model.items.length - 1, this.cursor));
    this.render();
  }

  move(delta: number) {
    if (!this.model) return;
    const n = this.model.items.length;
    if (!n) return;
    this.cursor = ((this.cursor + delta) % n + n) % n;
    this.render();
    this.scrollToCursor();
    this.model.onMove?.(this.cursor);
  }

  setCursor(i: number) {
    if (!this.model) return;
    this.cursor = Math.max(0, Math.min(this.model.items.length - 1, i));
    this.render();
    this.scrollToCursor();
    this.model.onMove?.(this.cursor);
  }

  select(index = this.cursor) {
    const item = this.model?.items[index];
    if (!item) return;
    if (item.action) item.action();
    else this.model?.onSelect?.(index);
  }

  private render() {
    if (!this.model) return;
    this.titleEl.textContent = this.model.title;
    this.hintEl.textContent =
      this.model.hint ?? 'DRAG VALUE TO SCROLL · TAP TO SELECT · CENTER = OK';
    const frag = document.createDocumentFragment();
    this.model.items.forEach((item, i) => {
      const li = document.createElement('li');
      if (i === this.cursor) li.className = 'sel';
      const label = document.createElement('span');
      label.textContent = `${item.selected ? '●' : ' '} ${item.label}`;
      li.appendChild(label);
      if (item.meta) {
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = item.meta;
        li.appendChild(meta);
      }
      li.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.cursor = i;
        this.render();
        this.select(i);
      });
      frag.appendChild(li);
    });
    this.listEl.replaceChildren(frag);
  }

  private scrollToCursor() {
    const el = this.listEl.children[this.cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }
}
