import { ID } from './id';

export type LocationDTO = {
  id: ID;
  path: string;
  dateAdded: Date;
  subLocations: SubLocationDTO[];
  tags: ID[];
  index: number;
  isWatchingFiles: boolean;
};

export type SubLocationDTO = {
  id: ID;
  name: string;
  isExcluded: boolean;
  subLocations: SubLocationDTO[];
  tags: ID[];
};
