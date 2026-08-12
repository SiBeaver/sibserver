// Embedding API client — compatible with OpenAI /v1/embeddings interface

export interface EmbeddingConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

function getConfig(): EmbeddingConfig | null {
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (!apiKey) return null;
  return {
    apiUrl: process.env.EMBEDDING_API_URL ?? 'https://api.siliconflow.cn/v1/embeddings',
    apiKey,
    model: process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3',
  };
}

let _config: EmbeddingConfig | null | undefined;

export function getEmbeddingConfig(): EmbeddingConfig | null {
  if (_config === undefined) _config = getConfig();
  return _config;
}

/**
 * Generate embeddings for a batch of texts.
 * Returns arrays of 1024-dimensional vectors in the same order as input.
 * Throws on API errors.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const config = getEmbeddingConfig();
  if (!config) throw new Error('嵌入服务未配置：未设置 EMBEDDING_API_KEY');
  if (texts.length === 0) return [];

  // API batch limit: 32 per request
  const BATCH_SIZE = 32;
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: batch,
        encoding_format: 'float',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`嵌入 API 错误 ${res.status}：${body}`);
    }

    const json = await res.json() as EmbeddingResponse;
    if (json.data.length !== batch.length) {
      throw new Error(`嵌入 API 返回不完整：期望 ${batch.length} 条，实际 ${json.data.length} 条`);
    }
    const byIndex = new Map(json.data.map(d => [d.index, d.embedding]));
    for (let j = 0; j < batch.length; j++) {
      const vec = byIndex.get(j);
      if (!vec) throw new Error(`嵌入 API 缺少第 ${j} 条结果`);
      results[i + j] = vec;
    }
  }

  return results;
}
