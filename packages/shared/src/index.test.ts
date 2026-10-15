import { describe, expect, it } from 'vitest';

import { PRODUCT_NAME } from './index';

describe('@routeswitch/shared', () => {
  it('exposes the product name', () => {
    expect(PRODUCT_NAME).toBe('RouteSwitch');
  });
});
