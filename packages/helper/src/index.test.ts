import { describe, expect, it } from 'vitest';

import { HELPER_DISPLAY_NAME } from './index';

describe('@routeswitch/helper', () => {
  it('builds its display name from the shared product name', () => {
    expect(HELPER_DISPLAY_NAME).toBe('RouteSwitch helper');
  });
});
