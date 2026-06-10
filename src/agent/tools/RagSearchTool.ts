import type { ToolDefinition, ToolResult } from '../ToolRegistry';
import type { LocalRagEngine } from '../../rag/LocalRagEngine';

export function createRagSearchTool(ragEngine: LocalRagEngine): ToolDefinition {
  return {
    name: 'rag_search',
    description:
      'Search the local indexed documentation for content relevant to a query. ' +
      'Use this when you need to look up project-specific docs, specs, or notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        top_k: { type: 'number', description: 'Number of chunks to return (default 5)' },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (!ragEngine.isIndexed) {
        return {
          success: false,
          output: 'RAG index is not built. Enable localLlm.rag.enabled and set indexPaths in settings.',
        };
      }
      const query = args['query'] as string;
      const topK = (args['top_k'] as number | undefined) ?? 5;
      const result = ragEngine.search(query, topK);
      return { success: true, output: result };
    },
  };
}
