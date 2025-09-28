/**
 * In this file we define the interfaces that Kisely will use to have types defined and build the sql queris,
 * these are an equivalent representation to the actual SQLite database schema.
 *
 * These are just interfaces, and updating here the structures will not actualizze the database, to do taht you will need
 * to manually write Kysely migrations taking care that the migration will update the database shema to be the same.
 */

import { ColumnType } from 'kysely';
import { ID } from '../api/id';

export interface Database {
  tags: Tags;
  tagSubTags: TagSubTags;
  tagImplied: TagImplied;
  tagAliases: TagAliases;
}

///// TAGS /////

export interface Tags {
  id: ID;
  name: string;
  dateAdded: ColumnType<Date, Date, never>;
  color: string;
  isHidden: boolean;
  isVisibleInherited: boolean;
  isHeader: boolean;
  description: string | null;
}

export interface TagSubTags {
  tagId: ID;
  subtagId: string;
}

export interface TagImplied {
  tagId: ID;
  impliedTagId: ID;
}

export interface TagAliases {
  tagId: ID;
  alias: string;
}
