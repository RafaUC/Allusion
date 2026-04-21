import { Insertable, Kysely } from 'kysely';
import {
  AllusionDB_SQL,
  deserializeDate,
  ExtraProperties as DbExtraProperties,
  serializeDate,
} from '../schemaTypes';
import { ExtraPropertyDTO } from 'src/api/extraProperty';
import { ID } from 'src/api/id';
import { upsertTable } from '../backend';

export class ExtraPropertyRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #maxVars: number;
  readonly #notifyChange: () => void;

  constructor(db: Kysely<AllusionDB_SQL>, maxVars: number, notifyChange: () => void) {
    this.#db = db;
    this.#maxVars = maxVars;
    this.#notifyChange = notifyChange;
  }

  async fetchExtraProperties(): Promise<ExtraPropertyDTO[]> {
    console.info('SQLite: Fetching extra properties...');
    const eProperties = (
      await this.#db.selectFrom('extraProperties').selectAll().orderBy('name').execute()
    ).map(
      (dbEp): ExtraPropertyDTO => ({
        id: dbEp.id,
        type: dbEp.type,
        name: dbEp.name,
        dateAdded: deserializeDate(dbEp.dateAdded),
      }),
    );
    return eProperties;
  }

  async createExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.info('SQLite: Creating extra property...', extraProperty);
    return this.upsertExtraProperty(extraProperty);
  }

  async saveExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    console.info('SQLite: Saving extra property...', extraProperty);
    return this.upsertExtraProperty(extraProperty);
  }

  async upsertExtraProperty(extraProperty: ExtraPropertyDTO): Promise<void> {
    const extraProperties: Insertable<DbExtraProperties>[] = [extraProperty].map((ep) => ({
      id: ep.id,
      type: ep.type,
      name: ep.name,
      dateAdded: serializeDate(ep.dateAdded),
    }));
    await this.#db.transaction().execute(async (trx) => {
      await upsertTable(this.#maxVars, trx, 'extraProperties', extraProperties, ['id'], ['dateAdded']); // eslint-disable-line prettier/prettier
    });
    this.#notifyChange();
  }

  async removeExtraProperties(extraPropertyIDs: ID[]): Promise<void> {
    console.info('SQLite: Removing extra properties...', extraPropertyIDs);
    // Cascade delte in other tables deleting from extraProperties table.
    await this.#db.deleteFrom('extraProperties').where('id', 'in', extraPropertyIDs).execute();
    this.#notifyChange();
  }
}
