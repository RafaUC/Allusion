import { ID } from '../../../../api/id';
import { ClientTag } from '../../../entities/Tag';
import { IAction, IExpansionState } from '../../types';

export const enum Flag {
  InsertNode,
  EnableEditing,
  DisableEditing,
  Expansion,
  ToggleNode,
  ExpandNode,
  ConfirmDeletion,
  AbortDeletion,
}

export interface ActionData<D> {
  source: ClientTag | undefined;
  data: D;
}

export type Action =
  | IAction<Flag.InsertNode, ActionData<{ parent: ID; node: ID }>>
  | IAction<Flag.EnableEditing | Flag.ToggleNode | Flag.ExpandNode, ActionData<ID>>
  | IAction<Flag.ConfirmDeletion, ActionData<ClientTag>>
  | IAction<Flag.DisableEditing | Flag.AbortDeletion, ActionData<undefined>>
  | IAction<
      Flag.Expansion,
      ActionData<IExpansionState | ((prevState: IExpansionState) => IExpansionState)>
    >;

export const Factory = {
  insertNode: (source: ClientTag | undefined, parent: ID, node: ID): Action => ({
    flag: Flag.InsertNode,
    data: { source, data: { parent, node } },
  }),
  enableEditing: (source: ClientTag | undefined, data: ID): Action => ({
    flag: Flag.EnableEditing,
    data: { source, data },
  }),
  disableEditing: (source: ClientTag | undefined): Action => ({
    flag: Flag.DisableEditing,
    data: { source, data: undefined },
  }),
  setExpansion: (
    source: ClientTag | undefined,
    data: IExpansionState | ((prevState: IExpansionState) => IExpansionState),
  ): Action => ({
    flag: Flag.Expansion,
    data: { source, data },
  }),
  toggleNode: (source: ClientTag | undefined, data: ID): Action => ({
    flag: Flag.ToggleNode,
    data: { source, data },
  }),
  expandNode: (source: ClientTag | undefined, data: ID): Action => ({
    flag: Flag.ExpandNode,
    data: { source, data },
  }),
  confirmDeletion: (data: ClientTag): Action => ({
    flag: Flag.ConfirmDeletion,
    data: { source: undefined, data },
  }),
  abortDeletion: (): Action => ({
    flag: Flag.AbortDeletion,
    data: { source: undefined, data: undefined },
  }),
};

export type State = {
  expansion: IExpansionState;
  editableNode: ID | undefined;
  deletableNode: ClientTag | undefined;
};

export function reducer(state: State, action: Action): State {
  switch (action.flag) {
    case Flag.InsertNode:
      return {
        ...state,
        expansion: state.expansion[action.data.data.parent]
          ? state.expansion
          : { ...state.expansion, [action.data.data.parent]: true },
        editableNode: action.data.data.node,
      };

    case Flag.EnableEditing:
      return {
        ...state,
        editableNode: action.data.data,
      };

    case Flag.DisableEditing:
      return {
        ...state,
        editableNode: action.data.data,
      };

    case Flag.Expansion:
      return {
        ...state,
        expansion: {
          ...(typeof action.data.data === 'function'
            ? action.data.data(state.expansion)
            : action.data.data),
        },
      };

    case Flag.ToggleNode:
      return {
        ...state,
        expansion: { ...state.expansion, [action.data.data]: !state.expansion[action.data.data] },
      };

    case Flag.ExpandNode:
      return {
        ...state,
        expansion: { ...state.expansion, [action.data.data]: true },
      };

    case Flag.ConfirmDeletion:
    case Flag.AbortDeletion:
      return {
        ...state,
        deletableNode: action.data.data,
      };

    default:
      return state;
  }
}
