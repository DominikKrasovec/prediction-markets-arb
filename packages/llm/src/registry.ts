import type { LLMProvider } from '@arb/types';
import { OpenAIProvider } from './providers/openai.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { OllamaProvider } from './providers/ollama.js';

const providerCache = new Map<string, LLMProvider>();

export function getProvider(id: string): LLMProvider {
  if (providerCache.has(id)) return providerCache.get(id)!;

  let provider: LLMProvider;

  switch (id) {
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY environment variable is required');
      provider = new OpenAIProvider(key);
      break;
    }
    case 'deepseek': {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error('DEEPSEEK_API_KEY environment variable is required');
      provider = new DeepSeekProvider(key);
      break;
    }
    case 'openrouter': {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) throw new Error('OPENROUTER_API_KEY environment variable is required');
      provider = new OpenRouterProvider(key);
      break;
    }
    case 'ollama': {
      provider = new OllamaProvider();
      break;
    }
    default:
      throw new Error(`Unknown LLM provider: ${id}`);
  }

  providerCache.set(id, provider);
  return provider;
}
