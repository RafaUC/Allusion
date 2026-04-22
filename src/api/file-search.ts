import { SearchConjunction } from './data-storage-search';
import { ID } from './id';
import { SearchCriteria } from './search-criteria';
import { ActiveSemanticQuery } from './semantic-search';

export type FileSearchDTO = {
  id: ID;
  name: string;
  index: number;
  rootGroup: SearchGroupDTO;
  /** Present when this saved search was created from a semantic query */
  semanticQuery?: ActiveSemanticQuery;
};

export type SearchGroupDTO = {
  id: ID;
  name: string;
  conjunction: SearchConjunction;
  children: Array<SearchGroupDTO | SearchCriteria>;
};
