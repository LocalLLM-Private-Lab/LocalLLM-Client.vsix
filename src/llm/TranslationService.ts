import { stripThink } from '../agent/agentUtils';
import type { ModelRouter } from './ModelRouter';
import type { OllamaClient } from './OllamaClient';

/**
 * translate モデルを使った日英ラウンドトリップ翻訳。
 *
 * - toEnglish: ユーザーの日本語入力を英語へ（LLM へ渡す前）
 * - toJapanese: LLM の英語出力を日本語へ（ユーザー表示前）
 *
 * 方針: コードブロック・インラインコード・パス・URL・識別子は変換せず、自然文のみ訳す。
 * 翻訳に失敗した場合は原文をそのまま返し、本来の処理を止めない。
 */
export class TranslationService {
  constructor(
    private readonly client: OllamaClient,
    private readonly modelRouter: ModelRouter,
  ) {}

  toEnglish(text: string, signal?: AbortSignal): Promise<string> {
    return this.translate(text, 'English', signal);
  }

  toJapanese(text: string, signal?: AbortSignal): Promise<string> {
    return this.translate(text, 'Japanese', signal);
  }

  private async translate(
    text: string,
    targetName: 'English' | 'Japanese',
    signal?: AbortSignal,
  ): Promise<string> {
    if (!text.trim()) return text;

    const system =
      `You are a translation engine. Translate the user's message into ${targetName}. ` +
      `Output ONLY the translation — no preamble, notes, explanations, or surrounding quotes. ` +
      `Preserve all Markdown structure, fenced/inline code, file paths, URLs, numbers and ` +
      `identifiers EXACTLY as-is; translate only natural-language prose. ` +
      `If the text is already ${targetName}, return it unchanged.`;

    try {
      const res = await this.client.chat(
        {
          model: this.modelRouter.getModel('translate'),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          think: false,
          options: { temperature: 0.2 },
        },
        signal,
      );
      const out = stripThink(res.message?.content ?? '').trim();
      return out || text;
    } catch (err) {
      // 失敗時は原文を返して処理を止めないが、無言だと「翻訳されていない」と
      // 区別がつかないため診断ログだけ残す。
      console.warn(`[TranslationService] ${targetName} translation failed:`, err);
      return text;
    }
  }
}
