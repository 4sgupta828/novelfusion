// Edit capture — the distiller's training signal and the exemplar store.
// Pure code: diffing is structural (Rule 18).

import fs from 'node:fs';
import { getDraft, insertEdit, newId } from '../db/index.js';
import { unifiedDiff } from '../util/diff.js';
import type { EditEvent, EditReasonChip } from '../domain/types.js';

export function captureEdit(
  workspaceId: string,
  draftId: string,
  editedFilePath: string,
  reasonChip: EditReasonChip | null,
): EditEvent {
  const draft = getDraft(workspaceId, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found in workspace ${workspaceId}`);
  const edited = fs.readFileSync(editedFilePath, 'utf-8').trim();
  if (edited === draft.content.trim()) {
    throw new Error('Edited content is identical to the draft — nothing to capture.');
  }
  const event: EditEvent = {
    id: newId('edt'),
    workspaceId,
    draftId,
    reasonChip,
    diff: unifiedDiff(draftId, draft.content, edited),
    editedContent: edited,
    holdout: draft.holdout, // an edit on a holdout draft is itself holdout (Rule 5)
    createdAt: new Date().toISOString(),
  };
  insertEdit(event);
  return event;
}
