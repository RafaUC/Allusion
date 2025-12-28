import { action, computed, Lambda, makeObservable, observable } from 'mobx';

import { camelCaseToSpaced } from '../../../common/fmt';
import {
  ArrayConditionDTO,
  ConditionDTO,
  DateConditionDTO,
  ExtraPropertyOperatorType,
  IndexSignatureConditionDTO,
  isExtraPropertyOperatorType,
  NumberConditionDTO,
  NumberOperatorType,
  SearchConjunction,
  StringConditionDTO,
  StringOperatorType,
} from '../../api/data-storage-search';
import { FileDTO } from '../../api/file';
import { generateId, ID } from '../../api/id';
import {
  CriteriaValueType,
  IBaseSearchCriteria,
  IDateSearchCriteria,
  IExtraProperySearchCriteria,
  INumberSearchCriteria,
  IStringSearchCriteria,
  ITagSearchCriteria,
  OperatorType,
  SearchCriteria,
  TagOperatorType,
} from '../../api/search-criteria';
import RootStore from '../stores/RootStore';
import { ExtraPropertyType as epType, ExtraPropertyValue } from 'src/api/extraProperty';
import { ClientSearchGroup } from './SearchItem';

// A dictionary of labels for (some of) the keys of the type we search for
export type SearchKeyDict = Partial<Record<keyof FileDTO, string>>;

export const CustomKeyDict: SearchKeyDict = {
  absolutePath: 'Path',
  locationId: 'Location',
};

export const SearchConjuctionSymbols: Record<SearchConjunction, string> = {
  and: 'AND',
  or: 'OR',
};

export const NumberOperatorSymbols: Record<NumberOperatorType, string> = {
  equals: '=',
  notEqual: '≠',
  smallerThan: '<',
  smallerThanOrEquals: '≤',
  greaterThan: '>',
  greaterThanOrEquals: '≥',
};

export const StringOperatorLabels: Record<StringOperatorType, string> = {
  equals: 'Equals',
  equalsIgnoreCase: 'Equals (case insensitive)',
  notEqual: 'Not Equal',
  startsWith: 'Starts With',
  startsWithIgnoreCase: 'Starts With (case insensitive)',
  notStartsWith: 'Not Starts With',
  contains: 'Contains',
  notContains: 'Not Contains',
};

export const ExtraPropertyOperatorLabels: Record<ExtraPropertyOperatorType, string> = {
  existsInFile: 'Exists in File',
  notExistsInFile: 'Does Not Exist in File',
};

export abstract class ClientFileSearchCriteria implements IBaseSearchCriteria {
  readonly id: ID;
  @observable public key: keyof FileDTO;
  @observable public valueType: CriteriaValueType;
  @observable public operator: OperatorType;
  @observable private _parent: ClientSearchGroup | undefined;

  private disposers: Lambda[] = [];

  constructor(
    id: ID | undefined,
    key: keyof FileDTO,
    valueType: CriteriaValueType,
    operator: OperatorType,
  ) {
    this.id = id ?? generateId();
    this.key = key;
    this.valueType = valueType;
    this.operator = operator;
    makeObservable(this);
  }

  // The component who call this metod must be observer.
  abstract getLabel(dict: SearchKeyDict, rootStore: RootStore): string;
  abstract serialize(rootStore: RootStore, duplicate?: boolean): SearchCriteria;
  abstract toCondition(rootStore: RootStore): ConditionDTO<FileDTO> | ConditionDTO<FileDTO>[];

  static deserialize(criteria: SearchCriteria): ClientFileSearchCriteria {
    const { valueType } = criteria;
    switch (valueType) {
      case 'number':
        const num = criteria as INumberSearchCriteria;
        return new ClientNumberSearchCriteria(num.id, num.key, num.value, num.operator);
      case 'date':
        const dat = criteria as IDateSearchCriteria;
        return new ClientDateSearchCriteria(dat.id, dat.key, dat.value, dat.operator);
      case 'string':
        const str = criteria as IStringSearchCriteria;
        return new ClientStringSearchCriteria(str.id, str.key, str.value, str.operator);
      case 'array':
        // Deserialize the array criteria: it's transformed from 1 ID into a list of IDs in serialize()
        // and untransformed here from a list of IDs to 1 ID
        const arr = criteria as ITagSearchCriteria;
        const op =
          arr.value.length <= 1
            ? arr.operator
            : arr.operator === 'contains'
            ? 'containsRecursively'
            : arr.operator === 'notContains'
            ? 'containsNotRecursively'
            : arr.operator;
        const value = arr.value[0];
        return new ClientTagSearchCriteria(arr.id, arr.key, value, op);
      case 'indexSignature':
        const map = criteria as IExtraProperySearchCriteria;
        return new ClientExtraPropertySearchCriteria(map.id, map.key, map.value, map.operator);
      default:
        throw new Error(`Unknown value type ${valueType}`);
    }
  }

  @computed get parent(): ClientSearchGroup | undefined {
    return this._parent;
  }

  @action.bound
  setParent(parent?: ClientSearchGroup): void {
    this._parent = parent;
  }

  dispose(): void {
    for (const disposer of this.disposers) {
      disposer();
    }
  }
}

export class ClientTagSearchCriteria extends ClientFileSearchCriteria {
  @observable public value?: ID;

  constructor(
    id: ID | undefined,
    key: keyof FileDTO,
    tagId?: ID,
    operator: TagOperatorType = 'containsRecursively',
  ) {
    super(id, key, 'array', operator);
    this.value = tagId;
    makeObservable(this);
  }

  /**
   * A flag for when the tag may be interpreted as a real tag, but contains text created by the application.
   * (this makes is so that "Untagged images" can be italicized)
   **/
  @action.bound isSystemTag = (): boolean => {
    return !this.value && !this.operator.toLowerCase().includes('not');
  };

  // don't use action on this because ClientTag.name can change and action is not reactive.
  // The component who call this metod must be observer.
  getLabel: (dict: SearchKeyDict, rootStore: RootStore) => string = (dict, rootStore) => {
    if (!this.value && !this.operator.toLowerCase().includes('not')) {
      return 'Untagged images';
    }
    return `${dict[this.key] || camelCaseToSpaced(this.key as string)} ${camelCaseToSpaced(
      this.operator,
    )} ${!this.value ? 'no tags' : rootStore.tagStore.get(this.value)?.name}`;
  };

  serialize = (rootStore: RootStore, duplicate = false): ITagSearchCriteria => {
    // for the *recursive options, convert it to the corresponding non-recursive option,
    // by putting all child IDs in the value in the serialization step
    let op = this.operator as TagOperatorType;
    let val = this.value ? [this.value] : [];
    if (val.length > 0 && op.includes('Recursively')) {
      const tag = rootStore.tagStore.get(val[0]);
      val = tag !== undefined ? Array.from(tag.getImpliedSubTree(), (t) => t.id) : [];
      // deserialization depends on val.length to determine correctly if it was recursively
      // so add an extra dummy value if length = 1
      if (val.length === 1) {
        val.push(val[0]);
      }
    }
    if (op === 'containsNotRecursively') {
      op = 'notContains';
    }
    if (op === 'containsRecursively') {
      op = 'contains';
    }

    return {
      id: duplicate ? generateId() : this.id,
      key: this.key,
      valueType: this.valueType,
      operator: op,
      value: val,
    };
  };
  toCondition = (rootStore: RootStore): ArrayConditionDTO<FileDTO, any> => {
    return this.serialize(rootStore) as ArrayConditionDTO<FileDTO, any>;
  };

  @action.bound setOperator(op: TagOperatorType): void {
    this.operator = op;
  }

  @action.bound setValue(value: ID): void {
    this.value = value;
  }
}

export class ClientExtraPropertySearchCriteria extends ClientFileSearchCriteria {
  @observable public value: [string, ExtraPropertyValue];

  constructor(
    id: ID | undefined,
    key: keyof FileDTO,
    value: [string, ExtraPropertyValue] = ['', 0],
    operator: OperatorType = 'equals',
  ) {
    super(id, key, 'indexSignature', operator);
    this.value = value;
    makeObservable(this);
  }

  // don't use action on this because ClientExtraProperty.name can change and action is not reactive.
  // The component who call this metod must be observer.
  getLabel: (dict: SearchKeyDict, rootStore: RootStore) => string = (_, rootStore) => {
    const ep = rootStore.extraPropertyStore.get(this.value[0]);
    let operatorString = undefined;
    if (ep !== undefined) {
      if (isExtraPropertyOperatorType(this.operator)) {
        operatorString = ExtraPropertyOperatorLabels[this.operator as ExtraPropertyOperatorType];
      } else if (ep.type === epType.text) {
        operatorString = StringOperatorLabels[this.operator as StringOperatorType];
      } else if (ep.type === epType.number) {
        operatorString = NumberOperatorSymbols[this.operator as NumberOperatorType];
      }
    }
    return `EP: "${ep?.name || 'Invalid Property'}" ${
      operatorString || camelCaseToSpaced(this.operator)
    } ${isExtraPropertyOperatorType(this.operator) ? '' : `"${this.value[1]}"`}`;
  };

  serialize = (_: unknown, duplicate = false): IExtraProperySearchCriteria => {
    return {
      id: duplicate ? generateId() : this.id,
      key: this.key,
      valueType: this.valueType,
      operator: this.operator,
      value: Array.from(this.value) as [string, ExtraPropertyValue],
    };
  };

  toCondition = (): IndexSignatureConditionDTO<FileDTO, ExtraPropertyValue> => {
    // Hacky
    return this.serialize(undefined) as unknown as IndexSignatureConditionDTO<
      FileDTO,
      ExtraPropertyValue
    >;
  };

  @action.bound setOperator(op: StringOperatorType | NumberOperatorType): void {
    this.operator = op;
  }

  @action.bound setValue(tuple: [string, ExtraPropertyValue]): void {
    this.value = tuple;
  }
}

export class ClientStringSearchCriteria extends ClientFileSearchCriteria {
  @observable public value: string;

  constructor(
    id: ID | undefined,
    key: keyof FileDTO,
    value: string = '',
    operator: StringOperatorType = 'contains',
  ) {
    super(id, key, 'string', operator);
    this.value = value;
    makeObservable(this);
  }

  @action.bound getLabel: (dict: SearchKeyDict) => string = (dict) =>
    `${dict[this.key] || camelCaseToSpaced(this.key as string)} ${
      StringOperatorLabels[this.operator as StringOperatorType] || camelCaseToSpaced(this.operator)
    } "${this.value}"`;

  serialize = (_: unknown, duplicate = false): IStringSearchCriteria => {
    return {
      id: duplicate ? generateId() : this.id,
      key: this.key,
      valueType: this.valueType,
      operator: this.operator as StringOperatorType,
      value: this.value,
    };
  };

  toCondition = (): StringConditionDTO<FileDTO> => {
    return this.serialize(undefined) as StringConditionDTO<FileDTO>;
  };

  @action.bound setOperator(op: StringOperatorType): void {
    this.operator = op;
  }

  @action.bound setValue(str: string): void {
    this.value = str;
  }
}

export class ClientNumberSearchCriteria extends ClientFileSearchCriteria {
  @observable public value: number;

  constructor(
    id: ID | undefined,
    key: keyof FileDTO,
    value: number = 0,
    operator: NumberOperatorType = 'greaterThanOrEquals',
  ) {
    super(id, key, 'number', operator);
    this.value = value;
    makeObservable(this);
  }
  @action.bound getLabel: () => string = () =>
    `${camelCaseToSpaced(this.key as string)} ${
      NumberOperatorSymbols[this.operator as NumberOperatorType] || camelCaseToSpaced(this.operator)
    } ${this.value}`;

  serialize = (I: unknown, duplicate = false): INumberSearchCriteria => {
    return {
      id: duplicate ? generateId() : this.id,
      key: this.key,
      valueType: this.valueType,
      operator: this.operator as NumberOperatorType,
      value: this.value,
    };
  };

  toCondition = (): NumberConditionDTO<FileDTO> => {
    return this.serialize(undefined) as NumberConditionDTO<FileDTO>;
  };

  @action.bound setOperator(op: NumberOperatorType): void {
    this.operator = op;
  }

  @action.bound setValue(num: number): void {
    this.value = num;
  }
}

export class ClientDateSearchCriteria extends ClientFileSearchCriteria {
  @observable public value: Date;

  constructor(
    id: ID | undefined,
    key: keyof FileDTO,
    value: Date = new Date(),
    operator: NumberOperatorType = 'equals',
  ) {
    super(id, key, 'date', operator);
    this.value = value;
    this.value.setHours(0, 0, 0, 0);
    makeObservable(this);
  }

  @action.bound getLabel: (dict: SearchKeyDict) => string = (dict) =>
    `${dict[this.key] || camelCaseToSpaced(this.key as string)} ${
      NumberOperatorSymbols[this.operator as NumberOperatorType] || camelCaseToSpaced(this.operator)
    } ${this.value.toLocaleDateString()}`;

  serialize = (_: unknown, duplicate = false): IDateSearchCriteria => {
    return {
      id: duplicate ? generateId() : this.id,
      key: this.key,
      valueType: this.valueType,
      operator: this.operator as NumberOperatorType,
      value: this.value,
    };
  };

  toCondition = (): DateConditionDTO<FileDTO> => {
    return this.serialize(undefined) as DateConditionDTO<FileDTO>;
  };

  @action.bound setOperator(op: NumberOperatorType): void {
    this.operator = op;
  }

  @action.bound setValue(date: Date): void {
    this.value = date;
  }
}
