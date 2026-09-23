import { getPathFromState } from 'expo-router/build/fork/getPathFromState';
import { appendQueryAndHash } from 'expo-router/build/fork/getPathFromState-forks';
import queryString from 'query-string';

describe('patched router query dependency', () => {
  it('preserves ordered parameters, repeated Unicode values and fragments', () => {
    expect(appendQueryAndHash('/wallet-data', {
      chain: 'test', q: 'a + b', list: ['é', '二'], '#': 'preview',
    })).toBe('/wallet-data?chain=test&q=a%20%2B%20b&list=%C3%A9&list=%E4%BA%8C#preview');
  });

  it('serializes a real router state with the dependency default export', () => {
    expect(getPathFromState({ routes: [{ name: 'wallet-data', params: { chain: 'test' } }] }, {
      screens: { 'wallet-data': 'wallet-data' },
    })).toBe('/wallet-data?chain=test');
  });

  it('handles malformed percent-encoded input without recursive decoding', () => {
    const malformed = '%EF%BF%BD'.repeat(2000) + '%C0%AF%ZZ';
    const parsed = queryString.parse(`q=${malformed}&chain=test`);
    expect(parsed.chain).toBe('test');
    expect(typeof parsed.q).toBe('string');
    expect(String(parsed.q)).toContain('%ZZ');
  });
});
