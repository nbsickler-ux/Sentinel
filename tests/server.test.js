import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  scoreToken,
  gradeFromScore,
  filterResponse,
  checkSanctionsWithSet,
  checkExploitAssociationWithRegistry,
} from '../lib/scoring.js';

// Note: scoreProtocol and scoreCounterparty are async functions that make network calls
// For comprehensive testing in a production environment, use integration tests with mocked APIs

// ============================================================
// TEST: gradeFromScore()
// ============================================================
describe('gradeFromScore', () => {
  test('should return grade A and SAFE verdict for score >= 85', () => {
    const result = gradeFromScore(85);
    expect(result.grade).toBe('A');
    expect(result.verdict).toBe('SAFE');
  });

  test('should return grade B and LOW_RISK verdict for score 70-84', () => {
    const result = gradeFromScore(75);
    expect(result.grade).toBe('B');
    expect(result.verdict).toBe('LOW_RISK');
  });

  test('should return grade C and CAUTION verdict for score 55-69', () => {
    const result = gradeFromScore(60);
    expect(result.grade).toBe('C');
    expect(result.verdict).toBe('CAUTION');
  });

  test('should return grade D and HIGH_RISK verdict for score 40-54', () => {
    const result = gradeFromScore(45);
    expect(result.grade).toBe('D');
    expect(result.verdict).toBe('HIGH_RISK');
  });

  test('should return grade F and DANGER verdict for score < 40', () => {
    const result = gradeFromScore(30);
    expect(result.grade).toBe('F');
    expect(result.verdict).toBe('DANGER');
  });

  test('should return grade F and DANGER verdict for score 0', () => {
    const result = gradeFromScore(0);
    expect(result.grade).toBe('F');
    expect(result.verdict).toBe('DANGER');
  });

  test('should handle boundary score 70 correctly', () => {
    const result = gradeFromScore(70);
    expect(result.grade).toBe('B');
    expect(result.verdict).toBe('LOW_RISK');
  });

  test('should handle boundary score 55 correctly', () => {
    const result = gradeFromScore(55);
    expect(result.grade).toBe('C');
    expect(result.verdict).toBe('CAUTION');
  });

  test('should handle boundary score 40 correctly', () => {
    const result = gradeFromScore(40);
    expect(result.grade).toBe('D');
    expect(result.verdict).toBe('HIGH_RISK');
  });

  test('should handle very high scores', () => {
    const result = gradeFromScore(999);
    expect(result.grade).toBe('A');
    expect(result.verdict).toBe('SAFE');
  });

  test('should handle negative scores', () => {
    const result = gradeFromScore(-50);
    expect(result.grade).toBe('F');
    expect(result.verdict).toBe('DANGER');
  });
});

// ============================================================
// TEST: filterResponse()
// ============================================================
describe('filterResponse', () => {
  const mockResult = {
    address: '0x1234567890123456789012345678901234567890',
    chain: 'base',
    verdict: 'SAFE',
    trust_grade: 'A',
    confidence: 0.9,
    trust_score: 85,
    token_name: 'TestToken',
    token_symbol: 'TEST',
    dimensions: {
      honeypot_safety: { score: 95, detail: 'No honeypot indicators' },
      tax_fairness: { score: 90, detail: 'Normal taxes' },
    },
    risk_flags: ['flag1', 'flag2'],
    meta: { response_time_ms: 100, data_freshness: '2026-03-26T00:00:00.000Z', sentinel_version: '0.4.0' },
  };

  test('should return full result for "full" detail level', () => {
    const result = filterResponse(mockResult, 'full');
    expect(result).toEqual(mockResult);
    expect(result.dimensions).toBeDefined();
    expect(result.trust_score).toBeDefined();
  });

  test('should remove dimensions and trust_score for "standard" detail level', () => {
    const result = filterResponse(mockResult, 'standard');
    expect(result.verdict).toBe('SAFE');
    expect(result.trust_grade).toBe('A');
    expect(result.confidence).toBe(0.9);
    expect(result.risk_flags).toBeDefined();
    expect(result.dimensions).toBeUndefined();
    expect(result.trust_score).toBeUndefined();
  });

  test('should include meta for "standard" detail level', () => {
    const result = filterResponse(mockResult, 'standard');
    expect(result.meta).toBeDefined();
  });

  test('should return minimal info for "minimal" detail level', () => {
    const result = filterResponse(mockResult, 'minimal');
    expect(result.address).toBe(mockResult.address);
    expect(result.chain).toBe('base');
    expect(result.verdict).toBe('SAFE');
    expect(result.trust_grade).toBe('A');
    expect(result.confidence).toBe(0.9);
    expect(result.token_name).toBe('TestToken');
    expect(result.token_symbol).toBe('TEST');
    expect(result.dimensions).toBeUndefined();
    expect(result.trust_score).toBeUndefined();
    expect(result.risk_flags).toBeUndefined();
  });

  test('should handle result with protocol_address instead of address', () => {
    const resultWithProtocol = { ...mockResult, protocol_address: mockResult.address, address: undefined };
    const filtered = filterResponse(resultWithProtocol, 'minimal');
    expect(filtered.address).toBe(mockResult.address);
  });

  test('should preserve meta in minimal response', () => {
    const result = filterResponse(mockResult, 'minimal');
    expect(result.meta).toBeDefined();
  });

  test('should handle missing token_name and token_symbol', () => {
    const resultWithoutToken = { ...mockResult, token_name: undefined, token_symbol: undefined };
    const filtered = filterResponse(resultWithoutToken, 'minimal');
    expect(filtered.token_name).toBeUndefined();
    expect(filtered.token_symbol).toBeUndefined();
  });

  test('should preserve confidence in all detail levels', () => {
    const result1 = filterResponse(mockResult, 'full');
    const result2 = filterResponse(mockResult, 'standard');
    const result3 = filterResponse(mockResult, 'minimal');

    expect(result1.confidence).toBe(0.9);
    expect(result2.confidence).toBe(0.9);
    expect(result3.confidence).toBe(0.9);
  });
});

// ============================================================
// TEST: scoreToken()
// ============================================================
describe('scoreToken', () => {
  test('should return UNKNOWN verdict when security data is not available', () => {
    const security = { available: false };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.trust_grade).toBe('N/A');
    expect(result.trust_score).toBeNull();
    expect(result.confidence).toBe(0.50);
    expect(result.risk_flags).toContain('No security data available for this token');
  });

  test('should detect honeypot token', () => {
    const security = {
      available: true,
      is_honeypot: true,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.risk_flags).toContain('HONEYPOT DETECTED - do not interact');
    expect(result.verdict).not.toBe('SAFE');
    expect(result.dimensions.honeypot_safety.score).toBe(0);
  });

  test('should penalize high tax tokens', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0.15,
      sell_tax: 0.20,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.risk_flags.some(flag => flag.includes('High tax'))).toBe(true);
    expect(result.dimensions.tax_fairness.score).toBeLessThanOrEqual(60);
  });

  test('should reward tokens with many holders', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 2,
      holder_count: 50000,
      creator_percent: 1,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.dimensions.liquidity_distribution.score).toBeGreaterThan(70);
  });

  test('should have high confidence when security data is available', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.confidence).toBe(0.90);
  });

  test('should detect hidden owner risk', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: true,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.risk_flags).toContain('Hidden owner detected');
  });

  test('should detect unverified contract source', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: false,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.risk_flags).toContain('Contract source is not verified');
  });

  test('should return valid trust_score between 0 and 100', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0.05,
      sell_tax: 0.05,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 5000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.trust_score).toBeGreaterThanOrEqual(0);
    expect(result.trust_score).toBeLessThanOrEqual(100);
    expect(result.dimensions).toBeDefined();
  });

  test('should include meta information in response', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.meta).toBeDefined();
    expect(result.meta.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.meta.data_freshness).toBeDefined();
    expect(result.meta.sentinel_version).toBeDefined();
  });

  test('should detect proxy contracts', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: true,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.risk_flags).toContain('Proxy contract - logic can be upgraded');
  });

  test('should detect ownership risks when owner holds significant supply', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 25,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const market = { available: false };
    const result = scoreToken(security, market);

    expect(result.risk_flags.some(flag => flag.includes('holds'))).toBe(true);
  });
});

// ============================================================
// TEST: checkSanctionsWithSet()
// ============================================================
describe('checkSanctionsWithSet', () => {
  const mockSanctionedSet = new Set([
    '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b',
    '0x7f367cc41522ce07553e823bf3be79a889debe1b',
  ]);

  test('should return object with required fields', () => {
    const result = checkSanctionsWithSet('0x1234567890123456789012345678901234567890', mockSanctionedSet, true);
    expect(result).toHaveProperty('sanctioned');
    expect(result).toHaveProperty('list');
    expect(result).toHaveProperty('list_loaded');
    expect(result).toHaveProperty('addresses_indexed');
  });

  test('should detect sanctioned addresses', () => {
    const result = checkSanctionsWithSet('0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b', mockSanctionedSet, true);
    expect(result.sanctioned).toBe(true);
    expect(result.list).toBe('OFAC SDN');
  });

  test('should normalize addresses to lowercase', () => {
    const result = checkSanctionsWithSet('0xD882CFC20F52F2599D84B8E8D58C7FB62CFE344B', mockSanctionedSet, true);
    expect(result.sanctioned).toBe(true);
  });

  test('should return sanctioned false for clean addresses', () => {
    const result = checkSanctionsWithSet('0x1111111111111111111111111111111111111111', mockSanctionedSet, true);
    expect(result.sanctioned).toBe(false);
    expect(result.list).toBeNull();
  });

  test('should return list_loaded status', () => {
    const result = checkSanctionsWithSet('0x1234567890123456789012345678901234567890', mockSanctionedSet, true);
    expect(result.list_loaded).toBe(true);
  });

  test('should return correct addresses_indexed count', () => {
    const result = checkSanctionsWithSet('0x1234567890123456789012345678901234567890', mockSanctionedSet, true);
    expect(result.addresses_indexed).toBe(2);
  });
});

// ============================================================
// TEST: checkExploitAssociationWithRegistry()
// ============================================================
describe('checkExploitAssociationWithRegistry', () => {
  const mockRegistry = {
    '0xhacked1234567890abcdef1234567890abcdef12': {
      name: 'HackedProtocol',
      hacked: true,
      hackDate: '2024-01-15',
      hackAmount: '$10M',
    },
    '0xsafe1234567890abcdef1234567890abcdef1234': {
      name: 'SafeProtocol',
      hacked: false,
    },
  };

  test('should return associated: true for hacked protocols', () => {
    const result = checkExploitAssociationWithRegistry('0xhacked1234567890abcdef1234567890abcdef12', mockRegistry);
    expect(result.associated).toBe(true);
    expect(result.protocol_name).toBe('HackedProtocol');
    expect(result.hack_date).toBe('2024-01-15');
    expect(result.hack_amount).toBe('$10M');
  });

  test('should return associated: false for unknown addresses', () => {
    const result = checkExploitAssociationWithRegistry('0x1111111111111111111111111111111111111111', mockRegistry);
    expect(result.associated).toBe(false);
  });

  test('should return associated: false for safe protocols', () => {
    const result = checkExploitAssociationWithRegistry('0xsafe1234567890abcdef1234567890abcdef1234', mockRegistry);
    expect(result.associated).toBe(false);
  });

  test('should normalize addresses to lowercase', () => {
    const result = checkExploitAssociationWithRegistry('0xHACKED1234567890ABCDEF1234567890ABCDEF12', mockRegistry);
    expect(result.associated).toBe(true);
  });
});

// ============================================================
// TEST: Input Validation & Edge Cases
// ============================================================
describe('Input Validation & Edge Cases', () => {
  test('checkSanctionsWithSet should handle any string input', () => {
    const result = checkSanctionsWithSet('not-an-address', new Set(), false);
    expect(result).toHaveProperty('sanctioned');
    expect(result.sanctioned).toBe(false);
  });

  test('filterResponse should handle missing optional fields', () => {
    const minimalResult = {
      verdict: 'SAFE',
      trust_grade: 'A',
    };
    const filtered = filterResponse(minimalResult, 'full');
    expect(filtered.verdict).toBe('SAFE');
  });

  test('gradeFromScore should handle very high scores', () => {
    const result = gradeFromScore(999);
    expect(result.grade).toBe('A');
    expect(result.verdict).toBe('SAFE');
  });

  test('gradeFromScore should handle negative scores', () => {
    const result = gradeFromScore(-50);
    expect(result.grade).toBe('F');
    expect(result.verdict).toBe('DANGER');
  });

  test('filterResponse should preserve all required fields in minimal mode', () => {
    const result = {
      address: '0xtest',
      chain: 'base',
      verdict: 'SAFE',
      trust_grade: 'A',
      confidence: 0.95,
      meta: { response_time_ms: 10, sentinel_version: '0.4.0' },
    };
    const filtered = filterResponse(result, 'minimal');

    expect(filtered.address).toBeDefined();
    expect(filtered.chain).toBeDefined();
    expect(filtered.verdict).toBeDefined();
    expect(filtered.trust_grade).toBeDefined();
    expect(filtered.confidence).toBeDefined();
  });
});

// ============================================================
// TEST: Security & Error Handling
// ============================================================
describe('Security & Error Handling', () => {
  test('scoreToken should not expose internals in error messages', () => {
    const result = scoreToken({ available: false }, {});
    expect(result.risk_flags).not.toContain(/Error|TypeError|Internal/);
  });

  test('filterResponse should not expose internal structure changes', () => {
    const result = {
      verdict: 'SAFE',
      trust_grade: 'A',
      _internal: 'should be hidden',
      debug_info: 'should be hidden',
    };
    const filtered = filterResponse(result, 'minimal');
    // Verify that minimal response has only expected fields
    expect(filtered).toHaveProperty('verdict');
    expect(filtered).toHaveProperty('trust_grade');
    expect(!filtered._internal || typeof filtered._internal === 'undefined').toBe(true);
  });

  test('risk flags should be clear and actionable', () => {
    const security = {
      available: true,
      is_honeypot: true,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 1000,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const result = scoreToken(security, {});

    result.risk_flags.forEach(flag => {
      expect(typeof flag).toBe('string');
      expect(flag.length).toBeGreaterThan(0);
      expect(flag).not.toMatch(/key|secret|token|password|api/i);
    });
  });

  test('scoreToken should handle edge case with zero holders', () => {
    const security = {
      available: true,
      is_honeypot: false,
      honeypot_with_same_creator: false,
      is_airdrop_scam: false,
      cannot_sell_all: false,
      cannot_buy: false,
      buy_tax: 0,
      sell_tax: 0,
      slippage_modifiable: false,
      personal_slippage_modifiable: false,
      hidden_owner: false,
      can_take_back_ownership: false,
      owner_change_balance: false,
      is_mintable: false,
      transfer_pausable: false,
      is_open_source: true,
      is_proxy: false,
      owner_percent: 5,
      holder_count: 0,
      creator_percent: 5,
      is_anti_whale: false,
      trading_cooldown: false,
      is_blacklisted: false,
      is_whitelisted: false,
    };
    const result = scoreToken(security, {});

    expect(result.dimensions).toBeDefined();
    expect(result.trust_score).toBeGreaterThanOrEqual(0);
  });
});
