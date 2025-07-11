import { ID } from './id';
import { FileDTO } from './file';
import {
  ExtraPropertyOperatorType,
  NumberOperatorType,
  StringOperatorType,
} from './data-storage-search';
import { ExtraPropertyValue } from './extraProperty';

export const BinaryOperators = ['equals', 'notEqual'] as const;
export type BinaryOperatorType = (typeof BinaryOperators)[number];

export const TagOperators = [
  'contains',
  'notContains',
  'containsRecursively',
  'containsNotRecursively',
] as const;
export type TagOperatorType = (typeof TagOperators)[number];

export type OperatorType =
  | ExtraPropertyOperatorType
  | TagOperatorType
  | NumberOperatorType
  | StringOperatorType
  | BinaryOperatorType;

// FFR: Boolean keys are not supported in IndexedDB/Dexie - must store booleans as 0/1
export interface IBaseSearchCriteria {
  key: keyof FileDTO;
  valueType: 'number' | 'date' | 'string' | 'array' | 'indexSignature';
  readonly operator: OperatorType;
}

export interface ITagSearchCriteria extends IBaseSearchCriteria {
  value: ID[];
  operator: TagOperatorType;
}

export interface IStringSearchCriteria extends IBaseSearchCriteria {
  value: string;
  operator: StringOperatorType;
}

export interface INumberSearchCriteria extends IBaseSearchCriteria {
  value: number;
  operator: NumberOperatorType;
}

export interface IDateSearchCriteria extends IBaseSearchCriteria {
  value: Date;
  /** TODO: Would be cool to have relative time: e.g. modified today/last month */
  operator: NumberOperatorType;
}

export interface IExtraProperySearchCriteria extends IBaseSearchCriteria {
  //key, value pair
  value: [string, ExtraPropertyValue];
  operator: OperatorType;
}

export type SearchCriteria =
  | ITagSearchCriteria
  | IStringSearchCriteria
  | INumberSearchCriteria
  | IDateSearchCriteria
  | IExtraProperySearchCriteria;
