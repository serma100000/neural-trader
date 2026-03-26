import { createLogger, type Logger } from '../shared/logger.js';
import type { PgClient } from './pg-client.js';
import type { IModelRepository, ModelRecord } from './types.js';

/**
 * ModelRepository: manages nt_model_registry for ML model lifecycle.
 * Supports registration, promotion, retirement, and version history.
 */
export class ModelRepository implements IModelRepository {
  private readonly log: Logger;

  constructor(private readonly pg: PgClient) {
    this.log = createLogger({ component: 'ModelRepository' });
  }

  /**
   * Register a new model version in the registry.
   */
  async register(
    model: Omit<ModelRecord, 'promotedAt' | 'retiredAt' | 'createdAt'>,
  ): Promise<void> {
    await this.pg.query(
      `INSERT INTO nt_model_registry (
        model_id, model_name, version, artifact_path, training_hash, metrics
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        model.modelId,
        model.modelName,
        model.version,
        model.artifactPath,
        model.trainingHash,
        JSON.stringify(model.metrics),
      ],
    );
    this.log.info(
      { modelId: model.modelId, modelName: model.modelName, version: model.version },
      'Model registered',
    );
  }

  /**
   * Promote a model to active status by setting promoted_at.
   * Only one version per model_name should be promoted at a time.
   */
  async promote(modelId: string): Promise<void> {
    await this.pg.transaction(async (client) => {
      // Get the model name to retire other promoted versions
      const modelResult = await client.query<{ model_name: string }>(
        'SELECT model_name FROM nt_model_registry WHERE model_id = $1',
        [modelId],
      );

      if (modelResult.rows.length === 0) {
        throw new Error(`Model not found: ${modelId}`);
      }

      const modelName = modelResult.rows[0].model_name;

      // Retire any currently promoted version of this model
      await client.query(
        `UPDATE nt_model_registry
         SET retired_at = now()
         WHERE model_name = $1
           AND promoted_at IS NOT NULL
           AND retired_at IS NULL
           AND model_id != $2`,
        [modelName, modelId],
      );

      // Promote the specified model
      await client.query(
        `UPDATE nt_model_registry
         SET promoted_at = now(), retired_at = NULL
         WHERE model_id = $1`,
        [modelId],
      );
    });

    this.log.info({ modelId }, 'Model promoted');
  }

  /**
   * Retire a model by setting retired_at.
   */
  async retire(modelId: string): Promise<void> {
    const result = await this.pg.query(
      `UPDATE nt_model_registry
       SET retired_at = now()
       WHERE model_id = $1 AND retired_at IS NULL`,
      [modelId],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Model not found or already retired: ${modelId}`);
    }

    this.log.info({ modelId }, 'Model retired');
  }

  /**
   * Get the currently active (promoted, not retired) version of a model.
   */
  async getActive(modelName: string): Promise<ModelRecord | null> {
    const result = await this.pg.query<ModelRow>(
      `SELECT * FROM nt_model_registry
       WHERE model_name = $1
         AND promoted_at IS NOT NULL
         AND retired_at IS NULL
       ORDER BY promoted_at DESC
       LIMIT 1`,
      [modelName],
    );

    if (result.rows.length === 0) return null;
    return rowToModel(result.rows[0]);
  }

  /**
   * Get the full version history for a model name, ordered by version descending.
   */
  async getHistory(modelName: string): Promise<ModelRecord[]> {
    const result = await this.pg.query<ModelRow>(
      `SELECT * FROM nt_model_registry
       WHERE model_name = $1
       ORDER BY version DESC`,
      [modelName],
    );
    return result.rows.map(rowToModel);
  }
}

/** Raw row from nt_model_registry */
interface ModelRow {
  model_id: string;
  model_name: string;
  version: number;
  artifact_path: string;
  training_hash: string;
  metrics: Record<string, unknown>;
  promoted_at: string | null;
  retired_at: string | null;
  created_at: string;
}

/** Convert a database row to a ModelRecord */
function rowToModel(row: ModelRow): ModelRecord {
  return {
    modelId: row.model_id,
    modelName: row.model_name,
    version: row.version,
    artifactPath: row.artifact_path,
    trainingHash: row.training_hash,
    metrics: row.metrics,
    promotedAt: row.promoted_at ? new Date(row.promoted_at) : null,
    retiredAt: row.retired_at ? new Date(row.retired_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export { rowToModel, type ModelRow };
