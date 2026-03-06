import type {
  CreateChatCompletionOptions,
  LogLine
} from "@browserbasehq/stagehand";
import { LLMClient } from "@browserbasehq/stagehand";
import zodToJsonSchema from "zod-to-json-schema";

type WorkersAIOptions = AiOptions & {
  logger?: (line: LogLine) => void;
};

const modelId = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * LLMClient implementation for Workers AI, used by Stagehand.
 * Uses @cf/meta/llama-3.3-70b-instruct-fp8-fast by default.
 */
export class WorkersAIClient extends LLMClient {
  public type = "workers-ai" as const;
  private binding: Ai;
  private options?: WorkersAIOptions;

  constructor(binding: Ai, options?: WorkersAIOptions) {
    super(modelId);
    this.binding = binding;
    this.options = options;
  }

  async createChatCompletion<T>({
    options
  }: CreateChatCompletionOptions): Promise<T> {
    const schema = options.response_model?.schema;
    this.options?.logger?.({
      category: "workersai",
      message: "thinking..."
    });

    // Adapt Stagehand message format to Workers AI format.
    // The structures are compatible at runtime but the TypeScript types diverge.
    const messages = options.messages.map((msg) => ({
      role: msg.role as "system" | "user" | "assistant",
      content:
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)
    }));

    const { response } = (await this.binding.run(
      this.modelName as keyof AiModels,
      {
        messages,
        tools: options.tools,
        response_format: schema
          ? {
              type: "json_schema",
              json_schema: zodToJsonSchema(schema)
            }
          : undefined,
        temperature: 0
      },
      this.options
    )) as AiTextGenerationOutput;

    this.options?.logger?.({
      category: "workersai",
      message: "completed thinking!"
    });

    // The caller expects { data: string } but the generic T can't be
    // validated at runtime. Use @ts-expect-error so this fails to compile
    // if the underlying error is ever resolved.
    // @ts-expect-error Stagehand expects a specific response shape that
    // varies by call site; the { data } wrapper satisfies all known callers
    return { data: response };
  }
}
