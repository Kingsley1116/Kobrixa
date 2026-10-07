/** Draft text and retry IDs survive pane changes, leaving and application restarts. */
export class ChatDraftStore {
  private records = new Map<string, { text: string; id?: string }>();
  constructor(
    private storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> = () => localStorage,
  ) {}

  get(key: string): { text: string; id?: string } {
    const cached = this.records.get(key);
    if (cached) return { ...cached };
    const raw = this.storage().getItem(key) ?? "";
    let value: { text: string; id?: string } = { text: raw };
    try {
      const parsed = JSON.parse(raw) as { text?: unknown; id?: unknown };
      if (typeof parsed?.text === "string")
        value = { text: parsed.text, ...(typeof parsed.id === "string" ? { id: parsed.id } : {}) };
    } catch {
      /* Migrate the earlier plain-text draft. */
    }
    this.records.set(key, value);
    return { ...value };
  }

  set(key: string, text: string): void {
    let previous = this.records.get(key);
    if (!previous) {
      try {
        previous = this.get(key);
      } catch {
        previous = { text: "" };
      }
    }
    this.records.set(key, previous.text === text ? previous : { text });
    this.persist(key);
  }

  prepare(key: string, text: string): string {
    const previous = this.get(key);
    const id = previous.text === text && previous.id ? previous.id : crypto.randomUUID();
    this.records.set(key, { text, id });
    this.persist(key);
    return id;
  }

  sent(key: string, text: string, id: string): boolean {
    const current = this.get(key);
    if (current.text === text && current.id === id) {
      this.storage().removeItem(key);
      this.records.set(key, { text: "" });
      return true;
    }
    return false;
  }

  /** Throws before leaving/closing if any draft cannot be saved. */
  flush(): void {
    for (const key of this.records.keys()) this.persist(key);
  }

  private persist(key: string): void {
    const value = this.records.get(key)!;
    if (value.text) this.storage().setItem(key, JSON.stringify(value));
    else this.storage().removeItem(key);
  }
}
export const chatDrafts = new ChatDraftStore();
