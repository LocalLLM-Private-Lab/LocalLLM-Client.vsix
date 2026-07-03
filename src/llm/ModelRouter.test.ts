import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRouter } from './ModelRouter';
import type { OllamaConfig } from '../config/schema';

function makeConfig(overrides: Partial<OllamaConfig['models']> = {}): OllamaConfig {
  return {
    connection: {
      mode: 'local',
      local: { host: 'localhost', port: 11434 },
      ssh: {
        host: '',
        sshPort: 22,
        username: '',
        privateKeyPath: '',
        remoteOllamaPort: 11434,
        localForwardPort: 11435,
      },
    },
    models: {
      general: 'general-model',
      chat: '',
      coder: '',
      vision: '',
      translate: '',
      compaction: '',
      ...overrides,
    },
    tokens: { maxTokens: 4096, contextWindow: 16384 },
    agent: {
      mode: 'auto',
      framework: 'tool-calling',
      enableGitIntegration: true,
      autoCommitBeforeChange: true,
      enableBehaviorVerify: true,
    },
    rag: { enabled: false, indexPaths: [] },
    outputLanguage: 'Japanese',
  };
}

describe('ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    router = new ModelRouter(makeConfig());
  });

  it('falls back to the general model when a slot is empty', () => {
    expect(router.getChatModel()).toBe('general-model');
    expect(router.getCoderModel()).toBe('general-model');
  });

  it('returns the slot-specific model when it is set', () => {
    router = new ModelRouter(makeConfig({ coder: 'coder-model' }));
    expect(router.getCoderModel()).toBe('coder-model');
    expect(router.getChatModel()).toBe('general-model');
  });

  it('getModel() resolves by TaskType with fallback', () => {
    router = new ModelRouter(makeConfig({ vision: 'vision-model' }));
    expect(router.getModel('vision')).toBe('vision-model');
    expect(router.getModel('translate')).toBe('general-model');
  });

  it('getModelForImages() prefers vision when images are present', () => {
    router = new ModelRouter(makeConfig({ vision: 'vision-model', coder: 'coder-model' }));
    expect(router.getModelForImages(true, 'coder')).toBe('vision-model');
    expect(router.getModelForImages(false, 'coder')).toBe('coder-model');
  });

  it('getModelForImages() falls back to general for the requested role without images', () => {
    expect(router.getModelForImages(false, 'chat')).toBe('general-model');
  });

  it('setGeneralModel() updates the in-memory general model', () => {
    router.setGeneralModel('new-general');
    expect(router.getGeneralModel()).toBe('new-general');
    expect(router.getChatModel()).toBe('new-general');
  });

  it('applyConfig() replaces the underlying config', () => {
    router.applyConfig(makeConfig({ general: 'swapped-general' }));
    expect(router.getGeneralModel()).toBe('swapped-general');
  });

  it('getMaxTokens() reads tokens.maxTokens from config', () => {
    expect(router.getMaxTokens()).toBe(4096);
  });

  describe('needsThinkParam', () => {
    it('returns true for qwen3 family models', () => {
      expect(router.needsThinkParam('qwen3:30b-a3b-instruct-q4_K_M')).toBe(true);
    });

    it('returns true for qwq models', () => {
      expect(router.needsThinkParam('qwq:32b')).toBe(true);
    });

    it('returns false for models with always-on thinking (e.g. gemma4)', () => {
      expect(router.needsThinkParam('gemma4:26b-a4b-it-q4_K_M')).toBe(false);
    });

    it('defaults to checking the general model when none is passed', () => {
      router = new ModelRouter(makeConfig({ general: 'qwen3:8b' }));
      expect(router.needsThinkParam()).toBe(true);
    });
  });
});
