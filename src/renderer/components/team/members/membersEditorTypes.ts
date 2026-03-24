import type { InlineChip } from '@renderer/types/inlineChip';

export interface MemberDraft {
  id: string;
  name: string;
  roleSelection: string;
  customRole: string;
  workflow?: string;
  workflowChips?: InlineChip[];
}

export interface MembersEditorValue {
  members: MemberDraft[];
}
