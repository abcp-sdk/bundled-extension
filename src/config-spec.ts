/**
 * Config knobs declared by the bundled extension. Exposed over the abc
 * protocol so the UI/config store can set them (and the agent can gate tools
 * whose required_config is unset).
 */
export function configSpec() {
  return {
    vlm_model: {
      description: 'Vision model ref (provider_id/model_id) used by image-read.',
      type: 'string' as const,
      scope: 'global' as const,
      default: '',
    },
    image_base_url: {
      description: 'Base URL for image-generate/image-edit (OpenAI-compatible).',
      type: 'string' as const,
      scope: 'global' as const,
      default: '',
    },
    image_api_key: {
      description: 'API key for image-generate/image-edit.',
      type: 'string' as const,
      scope: 'global' as const,
      default: '',
    },
    image_model: {
      description: 'Image model ref (provider_id/model_id) used by image-generate/image-edit.',
      type: 'string' as const,
      scope: 'global' as const,
      default: '',
    },
    brave_api_key: {
      description: 'Brave Search API key (X-Subscription-Token) for brave-search.',
      type: 'string' as const,
      scope: 'global' as const,
      default: '',
    },
  }
}
