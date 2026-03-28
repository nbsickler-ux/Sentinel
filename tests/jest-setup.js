// Mock axios globally to prevent network calls
import axios from 'axios';

jest.mock('axios');

// Mock common responses
axios.get.mockImplementation((url) => {
  if (url.includes('llama.fi')) {
    return Promise.resolve({ data: [] });
  }
  if (url.includes('github.com')) {
    return Promise.reject(new Error('Network mocked'));
  }
  if (url.includes('gopluslabs')) {
    return Promise.resolve({
      data: {
        result: {
          malicious_address: '0',
          phishing_activities: '0',
          blacklist_doubt: '0',
          contract_address: '0',
          mixer: '0',
          cybercrime: '0',
          money_laundering: '0',
          financial_crime: '0',
          darkweb_transactions: '0',
          sanctioned: '0',
          data_source: 'GoPlus',
        }
      }
    });
  }
  return Promise.resolve({ data: {} });
});

axios.post.mockResolvedValue({ data: {} });
