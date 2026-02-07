import { SearchConjunction } from './data-storage-search';
import { ID } from './id';
import { SearchCriteria } from './search-criteria';

export type FileSearchDTO = {
  id: ID;
  name: string;
  index: number;
  rootGroup: SearchGroupDTO;
};

export type SearchGroupDTO = {
  id: ID;
  name: string;
  conjunction: SearchConjunction;
  children: Array<SearchGroupDTO | SearchCriteria>;
};
