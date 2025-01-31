const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const readline = require("readline");
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs').promises;
const kleur = require('kleur');

// Configuration
const config = {
  tokens: [],
  proxies: [],
  proxyGroups: {},
  currentProxyIndices: {},
  baseUrl: "https://app.despeed.net",
  checkInterval: 60000,
  proxy: {
    enabled: false,
    type: "http",
    timeout: 10000,
    maxRetries: 3,
    testUrl: "https://api.ipify.org?format=json"
  }
};

// Modern console output helper
const logger = {
  info: (msg) => console.log(kleur.blue('ℹ'), kleur.white(msg)),
  success: (msg) => console.log(kleur.green('✔'), kleur.white(msg)),
  warning: (msg) => console.log(kleur.yellow('⚠'), kleur.white(msg)),
  error: (msg) => console.log(kleur.red('✖'), kleur.white(msg)),
  speed: (msg) => console.log(kleur.cyan('↯'), kleur.white(msg)),
  time: (msg) => console.log(kleur.magenta('⏰'), kleur.white(msg)),
  location: (msg) => console.log(kleur.yellow('📍'), kleur.white(msg)),
  network: (msg) => console.log(kleur.blue('🌐'), kleur.white(msg))
};

// Load tokens from file
async function loadTokensFromFile() {
  try {
    const content = await fs.readFile('token.txt', 'utf8');
    const tokens = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    if (tokens.length === 0) {
      throw new Error('No valid tokens found in token.txt');
    }
    
    config.tokens = tokens;
    logger.success(`Loaded ${tokens.length} tokens from token.txt`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error('token.txt file not found');
    } else {
      logger.error(`Error reading token file: ${error.message}`);
    }
    return false;
  }
}

// Load proxy from file
async function loadProxyFromFile() {
  try {
    const proxyContent = await fs.readFile('proxy.txt', 'utf8');
    const proxies = proxyContent.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    if (proxies.length === 0) {
      logger.error('proxy.txt file has no valid proxies');
      return null;
    }

    // Convert proxy URL format
    config.proxies = proxies.map(proxyUrl => {
      // Convert smartproxy format to http proxy URL
      if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
        return `http://${proxyUrl}`;
      }
      return proxyUrl;
    });

    logger.success(`Loaded ${config.proxies.length} proxies successfully`);
    logger.info('Proxy format example:');
    logger.info(`- Original: ${proxies[0]}`);
    logger.info(`- Converted: ${config.proxies[0]}`);
    
    config.proxy.enabled = true;
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error('proxy.txt file not found');
    } else {
      logger.error(`Error reading proxy file: ${error.message}`);
    }
    return null;
  }
}

// Setup proxy groups function
async function setupProxyGroups(tokens, proxies) {
  if (!proxies || proxies.length === 0) {
    logger.error('No available proxies');
    return;
  }

  logger.info(`Token count: ${tokens.length}, Proxy count: ${proxies.length}`);
  
  // Calculate proxies per token (even distribution)
  const proxiesPerToken = Math.floor(proxies.length / tokens.length);
  const remainingProxies = proxies.length % tokens.length;
  
  logger.info('Proxy distribution method:');
  logger.info(`- Base allocation per token: ${proxiesPerToken}`);
  if (remainingProxies > 0) {
    logger.info(`- Additional proxies to be assigned to last token: ${remainingProxies}`);
    logger.info(`- Total proxies assigned to last token: ${proxiesPerToken + remainingProxies}`);
  }
  
  tokens.forEach((token, index) => {
    const startIndex = index * proxiesPerToken;
    const endIndex = index === tokens.length - 1 
      ? proxies.length  // Last token will receive all remaining proxies
      : startIndex + proxiesPerToken;
    
    config.proxyGroups[token] = proxies.slice(startIndex, endIndex);
    config.currentProxyIndices[token] = 0;
  });

  // Print configured group information
  logger.success('Proxy group setup completed:');
  tokens.forEach((token, index) => {
    logger.info(`Token ${index + 1}: ${config.proxyGroups[token].length} proxies assigned`);
  });
}

// Get next proxy for token
function getNextProxyForToken(token) {
  if (!token || !config.proxyGroups || !config.proxyGroups[token]) {
    return config.proxies[0]; // Return default value as first proxy
  }
  
  const proxyGroup = config.proxyGroups[token];
  const currentIndex = config.currentProxyIndices[token] || 0;
  const proxy = proxyGroup[currentIndex];
  
  // Cycle to next index
  config.currentProxyIndices[token] = (currentIndex + 1) % proxyGroup.length;
  
  return proxy;
}

// Create proxy agent function
async function createProxyAgent(token) {
  if (!config.proxy.enabled) return undefined;
  
  const proxyUrl = getNextProxyForToken(token);
  if (!proxyUrl) return undefined;

  // Remove http:// and recreate
  const cleanUrl = proxyUrl.replace('http://', '');
  return new HttpsProxyAgent(`http://${cleanUrl}`);
}

// Check proxy availability
async function isProxyAlive(proxyAgent) {
  try {
    const response = await fetch(config.proxy.testUrl, {
      agent: proxyAgent,
      timeout: config.proxy.timeout
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Get working proxy agent with retries
async function getProxyAgent(token, retries = config.proxy.maxRetries) {
  if (!config.proxy.enabled) return undefined;

  for (let i = 0; i < retries; i++) {
    try {
      const agent = await createProxyAgent(token);
      if (!agent) {
        return undefined;
      }

      if (await isProxyAlive(agent)) {
        logger.success(`Proxy connection successful`);
        return agent;
      }

      logger.warning(`Proxy check failed, retrying ${i + 1}/${retries}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));

    } catch (error) {
      logger.error(`Proxy error (${i + 1}/${retries}): ${error.message}`);
      if (i === retries - 1) {
        throw new Error('Maximum proxy retry count reached');
      }
    }
  }

  return undefined;
}

// Generate random location
function generateRandomLocation() {
  const bounds = {
    minLat: 18.0,
    maxLat: 53.55,
    minLng: 73.66,
    maxLng: 135.05
  };
  
  const latitude = bounds.minLat + Math.random() * (bounds.maxLat - bounds.minLat);
  const longitude = bounds.minLng + Math.random() * (bounds.maxLng - bounds.minLng);
  
  return {
    latitude: Math.round(latitude * 1000000) / 1000000,
    longitude: Math.round(longitude * 1000000) / 1000000
  };
}

// Initialize configuration
async function initConfig() {
  logger.info('Initializing configuration...');

  const tokensLoaded = await loadTokensFromFile();
  if (!tokensLoaded) {
    throw new Error('Failed to load tokens from token.txt');
  }

  const proxyFileExists = await loadProxyFromFile();
  if (proxyFileExists) {
    logger.success('Loaded proxy settings from proxy.txt');
    config.proxy.enabled = true;
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    logger.info(`\nProxy distribution information:`);
    logger.info(`- Total tokens: ${config.tokens.length}`);
    logger.info(`- Total proxies: ${config.proxies.length}`);
    logger.info(`- Base allocation per token: ${Math.floor(config.proxies.length / config.tokens.length)}`);
    if (config.proxies.length % config.tokens.length > 0) {
      logger.info(`- Last token will receive additional ${config.proxies.length % config.tokens.length} proxies`);
    }
    
    await new Promise((resolve) => {
      rl.question('\nPress Enter to continue with this distribution method.', () => {
        rl.close();
        resolve();
      });
    });
    
    await setupProxyGroups(config.tokens, config.proxies);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (query) => new Promise((resolve) => rl.question(query, resolve));

    const useProxy = (await question(kleur.cyan('Do you want to use a proxy? (y/n): '))).toLowerCase() === 'y';
    if (useProxy) {
      config.proxy.enabled = true;
      const proxyUrl = await question(kleur.cyan('Enter proxy URL (e.g., http://user:pass@ip:port or socks5://ip:port): '));
      config.proxy.url = proxyUrl;
      
      if (proxyUrl.startsWith('socks4://')) {
        config.proxy.type = 'socks4';
      } else if (proxyUrl.startsWith('socks5://')) {
        config.proxy.type = 'socks5';
      } else {
        config.proxy.type = 'http';
      }
    }

    const interval = await question(kleur.cyan('Enter check interval (minutes, default 1): '));
    config.checkInterval = (parseInt(interval) || 1) * 60000;

    rl.close();
  }

  logger.success('Configuration completed!');
  logger.info('Current settings:');
  const safeConfig = {...config, tokens: `${config.tokens.length} tokens loaded`};
  console.log(kleur.gray(JSON.stringify(safeConfig, null, 2)));
}

// General header fetching
function getCommonHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'sec-ch-ua': '"Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Origin': 'https://app.despeed.net',
    'Referer': 'https://app.despeed.net/dashboard'
  };
}

// Token validity check
async function validateToken(token) {
  if (!token) {
    throw new Error('Token not found');
  }
  
  try {
    const tokenData = JSON.parse(atob(token.split('.')[1]));
    if ((tokenData.exp - 90) * 1000 < Date.now()) {
      throw new Error('Token expired');
    }

    const proxyAgent = await getProxyAgent(token);
    const profileResponse = await fetch(`${config.baseUrl}/v1/api/auth/profile`, {
      headers: getCommonHeaders(token),
      agent: proxyAgent,
      timeout: 30000
    });

    if (!profileResponse.ok) {
      throw new Error('Invalid token');
    }

    return true;
  } catch (error) {
    logger.error(`Token validation failed: ${error.message}`);
    return false;
  }
}

// Perform speed test
async function performSpeedTest() {
  try {
    logger.network('Starting network speed measurement...');
    
    const metadata = {
      client_name: 'speed-measurementlab-net-1',
      client_session_id: crypto.randomUUID()
    };

    const proxyAgent = await getProxyAgent();
    
    const locateUrl = new URL('https://locate.measurementlab.net/v2/nearest/ndt/ndt7');
    locateUrl.search = new URLSearchParams(metadata).toString();
    
    logger.info('Finding speed test server...');
    const locateResponse = await fetch(locateUrl, {
      agent: proxyAgent,
      timeout: 30000
    });

    if (!locateResponse.ok) {
      throw new Error(`Failed to find speed test server: ${locateResponse.status}`);
    }

    const serverData = await locateResponse.json();
    if (!serverData.results || !serverData.results[0]) {
      throw new Error('No available speed test server');
    }

    const server = serverData.results[0];
    logger.success(`Selected server: ${server.machine}`);

    const downloadUrl = server.urls['wss:///ndt/v7/download'];
    const uploadUrl = server.urls['wss:///ndt/v7/upload'];

    // Download test
    logger.network('Starting download test...');
    let downloadSpeed = 0;
    await new Promise((resolve) => {
      const wsOptions = config.proxy.enabled ? {
        agent: proxyAgent
      } : undefined;
      
      const ws = new WebSocket(downloadUrl, 'net.measurementlab.ndt.v7', wsOptions);
      let startTime = Date.now();
      let totalBytes = 0;
      let lastMeasurement = null;

      ws.on('open', () => {
        startTime = Date.now();
        totalBytes = 0;
      });

      ws.on('message', (data) => {
        if (typeof data === 'string') {
          lastMeasurement = JSON.parse(data);
          return;
        }
        totalBytes += data.length;
        const now = Date.now();
        const duration = (now - startTime) / 1000;
        if (duration >= 10) {
          downloadSpeed = (totalBytes * 8) / (duration * 1000000);
          ws.close();
        }
      });

      ws.on('close', () => {
        logger.speed(`Download: ${downloadSpeed.toFixed(2)} Mbps`);
        resolve();
      });

      ws.on('error', (error) => {
        logger.error(`Download test error: ${error.message}`);
        resolve();
      });
    });

    // Upload test
    logger.network('Starting upload test...');
    let uploadSpeed = 0;
    await new Promise((resolve) => {
      const wsOptions = config.proxy.enabled ? {
        agent: proxyAgent
      } : undefined;
      
      const ws = new WebSocket(uploadUrl, 'net.measurementlab.ndt.v7', wsOptions);
      let startTime = null;
      let totalBytes = 0;
      let lastMeasurement = null;
      let uploadInterval = null;
      
      // Create smaller chunks for upload
      const chunkSize = 16384; // 16KB chunks
      const uploadData = Buffer.alloc(chunkSize);
      crypto.randomFillSync(uploadData);

      ws.on('open', () => {
        startTime = Date.now();
        totalBytes = 0;

        uploadInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const now = Date.now();
            const duration = (now - startTime) / 1000;
            
            if (duration >= 10) {
              uploadSpeed = (totalBytes * 8) / (duration * 1000000);
              clearInterval(uploadInterval);
              ws.close();
              return;
            }

            // Send data only if WebSocket buffer is not too full
            if (ws.bufferedAmount < 1024 * 1024) {
              ws.send(uploadData);
              totalBytes += uploadData.length;
            }
          }
        }, 1); // Send data every millisecond
      });

      ws.on('message', (data) => {
        if (typeof data === 'string') {
          try {
            lastMeasurement = JSON.parse(data);
            if (lastMeasurement.TCPInfo) {
              const tcpInfo = lastMeasurement.TCPInfo;
              const elapsed = tcpInfo.ElapsedTime || 1;  // Prevent division by zero
              if (elapsed > 0) {
                const tmpSpeed = (tcpInfo.BytesReceived / elapsed) * 8;
                if (tmpSpeed > uploadSpeed) {
                  uploadSpeed = tmpSpeed;
                }
              }
            }
          } catch (e) {
            logger.error(`Error parsing server message: ${e.message}`);
          }
        }
      });

      ws.on('close', () => {
        if (uploadInterval) {
          clearInterval(uploadInterval);
        }
        
        // Calculate final speed if not already set
        if (uploadSpeed === 0 && startTime && totalBytes > 0) {
          const duration = (Date.now() - startTime) / 1000;
          uploadSpeed = (totalBytes * 8) / (duration * 1000000);
        }
        
        logger.speed(`Upload: ${uploadSpeed.toFixed(2)} Mbps`);
        resolve();
      });

      ws.on('error', (error) => {
        if (uploadInterval) {
          clearInterval(uploadInterval);
        }
        logger.error(`Upload test error: ${error.message}`);
        resolve();
      });

      // Set a timeout to ensure the test doesn't run forever
      setTimeout(() => {
        if (uploadInterval) {
          clearInterval(uploadInterval);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }, 15000); // 15 second timeout
    });

    return { downloadSpeed, uploadSpeed };

  } catch (error) {
    logger.error(`Speed test error: ${error.message}`);
    return { downloadSpeed: 0, uploadSpeed: 0 };
  }
}

// Report results
async function reportResults(token, downloadSpeed, uploadSpeed, location) {
  try {
    logger.info('Submitting test results...');

    const proxyAgent = await getProxyAgent(token);
    const response = await fetch(`${config.baseUrl}/v1/api/points`, {
      method: 'POST',
      headers: {
        ...getCommonHeaders(token),
        'Content-Type': 'application/json'
      },
      agent: proxyAgent,
      timeout: 30000,
      body: JSON.stringify({
        download_speed: Math.round(downloadSpeed * 100) / 100,
        upload_speed: Math.round(uploadSpeed * 100) / 100,
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to submit results: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success) {
      logger.success('Results submitted successfully');
      return data;
    } else {
      throw new Error(data.message || 'Failed to submit results');
    }

  } catch (error) {
    logger.error(`Error submitting results: ${error.message}`);
    return null;
  }
}

// Display account information
async function displayAccountInfo(token) {
  try {
    logger.info('\n=== Account Information ===');
    
    const proxyAgent = await getProxyAgent(token);
    const profileResponse = await fetch(`${config.baseUrl}/v1/api/auth/profile`, {
      headers: getCommonHeaders(token),
      agent: proxyAgent,
      timeout: 30000
    });

    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      logger.info(`Username: ${profile.data.username || "Not set"}`);
      logger.info(`Email: ${profile.data.email || "Not set"}`);
    }
    
    logger.info('=== ============ ===\n');
  } catch (error) {
    logger.error(`Error getting account information: ${error.message}`);
  }
}

// Single account processing
async function processAccount(token, accountIndex) {
  try {
    logger.info(`\n=== Processing Account ${accountIndex + 1} ===`);
    logger.time(`Time: ${new Date().toLocaleString()}`);
    
    const isValid = await validateToken(token);
    if (!isValid) {
      logger.error(`Token ${accountIndex + 1} is invalid or expired`);
      return false;
    }
    logger.success(`Token ${accountIndex + 1} validation successful`);
    
    await displayAccountInfo(token);
    
    const location = generateRandomLocation();
    logger.location(`Speed test location: ${location.latitude}, ${location.longitude}`);
    
    logger.network('Starting speed test...');
    const { downloadSpeed, uploadSpeed } = await performSpeedTest();
    logger.speed(`Final download speed: ${downloadSpeed.toFixed(2)} Mbps`);
    logger.speed(`Final upload speed: ${uploadSpeed.toFixed(2)} Mbps`);
    
    const result = await reportResults(token, downloadSpeed, uploadSpeed, location);
    
    if (result && result.success) {
      logger.success('Speed test completed and results reported');
      return true;
    } else {
      logger.error('Failed to report results');
      if (result && result.message) {
        logger.error(`Failure reason: ${result.message}`);
      }
      return false;
    }
    
  } catch (error) {
    logger.error(`Error processing account ${accountIndex + 1}: ${error.message}`);
    if (error.response) {
      try {
        const errorData = await error.response.json();
        logger.error(`Server response: ${JSON.stringify(errorData)}`);
      } catch {
        logger.error(`Status code: ${error.response.status}`);
      }
    }
    return false;
  }
}

// Main loop
async function main() {
  try {
    logger.info('\n=== Starting Multi-Account Speed Test ===');
    
    for (let i = 0; i < config.tokens.length; i++) {
      await processAccount(config.tokens[i], i);
      
      if (i < config.tokens.length - 1) {
        logger.info('Waiting 5 seconds before processing next account...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
  } catch (error) {
    logger.error(`Error in main loop: ${error.message}`);
  } finally {
    const nextTime = new Date(Date.now() + config.checkInterval);
    logger.time(`Next test cycle scheduled for: ${nextTime.toLocaleString()}`);
    logger.info(`Interval: ${Math.round(config.checkInterval / 1000 / 60)} minutes`);
    logger.info('=== Speed Test Cycle Completed ===\n');
    setTimeout(main, config.checkInterval);
  }
}

// Process exit handling
process.on('SIGINT', () => {
  logger.warning('\nReceived exit signal');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.warning('\nReceived exit signal');
  process.exit(0);
});

// Program start
console.clear();
logger.info('Initializing Multi-Account DeSpeed Test Client...');
initConfig().then(() => {
  main();
}).catch(error => {
  logger.error(`Initialization error: ${error.message}`);
  process.exit(1);
});
