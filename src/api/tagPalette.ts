import { ID } from './id';

export type TagPaletteDTO = {
  id: ID;
  name: string;
  index: number;
  // in this case tags can appear multiple times in a pallete
  tags: ID[];
};
