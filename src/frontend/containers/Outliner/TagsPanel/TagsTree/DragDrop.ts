import { DnDTagType } from '../../../../contexts/TagDnDContext';
import { createDragReorderHelper } from '../../TreeItemDnD';

export const DnDHelper = createDragReorderHelper('tag-dnd-preview', DnDTagType);
