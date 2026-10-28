// Session-scoped reference documents for a meeting chat.
//
// Mode reference files persist on a mode forever. These do not: they ride the
// current conversation ("based on this PDF") and go away on New chat. Phone
// upload and the overlay picker both write here; chat / WTA read the same
// block so both surfaces answer from the same documents.

import { EventEmitter } from 'events';
import crypto from 'crypto';

export const SESSION_REFERENCE_MAX_DOCS = 4;
export const SESSION_REFERENCE_MAX_CHARS = 80_000;

export interface SessionReferenceDoc {
  id: string;
  fileName: string;
  content: string;
  pageCount?: number;
}

export type SessionReferenceMeta = Pick<SessionReferenceDoc, 'id' | 'fileName' | 'pageCount'>;

const toMeta = (doc: SessionReferenceDoc): SessionReferenceMeta => ({
  id: doc.id,
  fileName: doc.fileName,
  ...(typeof doc.pageCount === 'number' ? { pageCount: doc.pageCount } : {}),
});

export class SessionReferenceStore {
  private static _instance: SessionReferenceStore | null = null;
  private docs: SessionReferenceDoc[] = [];
  private emitter = new EventEmitter();

  static getInstance(): SessionReferenceStore {
    if (!this._instance) this._instance = new SessionReferenceStore();
    return this._instance;
  }

  /** Tests only: drop the singleton so cases cannot leak documents. */
  static resetForTests(): void {
    this._instance?.emitter.removeAllListeners();
    this._instance = null;
  }

  add(input: { fileName: string; content: string; pageCount?: number; id?: string }): SessionReferenceDoc {
    const fileName = String(input.fileName || '').trim() || 'document.txt';
    const content = String(input.content || '');
    if (!content.trim()) {
      throw new Error('document has no extractable text');
    }
    const doc: SessionReferenceDoc = {
      id: input.id && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : crypto.randomUUID(),
      fileName,
      content,
      ...(typeof input.pageCount === 'number' && input.pageCount > 0 ? { pageCount: input.pageCount } : {}),
    };
    this.docs = [...this.docs.filter((d) => d.id !== doc.id), doc].slice(-SESSION_REFERENCE_MAX_DOCS);
    this.emit();
    return doc;
  }

  remove(id: string): boolean {
    const next = this.docs.filter((d) => d.id !== id);
    if (next.length === this.docs.length) return false;
    this.docs = next;
    this.emit();
    return true;
  }

  clear(): void {
    if (this.docs.length === 0) return;
    this.docs = [];
    this.emit();
  }

  list(): SessionReferenceMeta[] {
    return this.docs.map(toMeta);
  }

  getAll(): SessionReferenceDoc[] {
    return this.docs.map((d) => ({ ...d }));
  }

  /**
   * Prompt block for the current documents. Truncates to SESSION_REFERENCE_MAX_CHARS
   * across all files so a large PDF cannot blow the turn by itself.
   */
  buildContextBlock(): string {
    if (this.docs.length === 0) return '';
    const parts: string[] = [
      'SESSION REFERENCE DOCUMENTS (answer from these when the question is about this document; the meeting transcript is separate):',
    ];
    let used = 0;
    for (const doc of this.docs) {
      const header = `--- ${doc.fileName}${doc.pageCount ? ` (${doc.pageCount} pages)` : ''} ---`;
      const room = SESSION_REFERENCE_MAX_CHARS - used - header.length - 2;
      if (room <= 0) break;
      const body = doc.content.length > room
        ? `${doc.content.slice(0, Math.max(0, room - 24))}\n[...document truncated]`
        : doc.content;
      parts.push(`${header}\n${body}`);
      used += header.length + body.length + 2;
    }
    return parts.join('\n\n');
  }

  onChange(listener: (items: SessionReferenceMeta[]) => void): () => void {
    this.emitter.on('change', listener);
    return () => {
      this.emitter.off('change', listener);
    };
  }

  private emit(): void {
    this.emitter.emit('change', this.list());
  }
}

/** Prepend session documents to a chat/WTA context string. */
export function withSessionReferenceContext(context?: string): string | undefined {
  const block = SessionReferenceStore.getInstance().buildContextBlock();
  if (!block) return context;
  const existing = typeof context === 'string' ? context.trim() : '';
  return existing ? `${block}\n\n${existing}` : block;
}
