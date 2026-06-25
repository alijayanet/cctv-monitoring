// ONVIF Discovery untuk auto-detect RTSP format
const dgram = require('dgram');
const net = require('net');
const http = require('http');
const config = require('./config.json');

// Config Defaults
const ONVIF_USER = config.onvif?.username || 'admin';
const ONVIF_PASS = config.onvif?.password || 'admin';
const DISCOVERY_TIMEOUT = config.onvif?.discovery_timeout || 5000;

// ONVIF Discovery via WS-Discovery
function discoverONVIFDevices() {
    console.log(`🔍 Melakukan ONVIF discovery untuk kamera (Timeout: ${DISCOVERY_TIMEOUT}ms)...\n`);
    
    return new Promise((resolve) => {
        const client = dgram.createSocket('udp4');
        const devices = [];
        
        // WS-Discovery probe message
        const probeMessage = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery">
  <soap:Header>
    <wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
    <wsa:MessageID>uuid:${generateUUID()}</wsa:MessageID>
  </soap:Header>
  <soap:Body>
    <wsd:Probe>
      <wsd:Types>dn:NetworkVideoTransmitter</wsd:Types>
    </wsd:Probe>
  </soap:Body>
</soap:Envelope>`;
        
        client.on('message', (msg, rinfo) => {
            const message = msg.toString();
            
            if (message.includes('onvif') || message.includes('ONVIF')) {
                console.log(`✅ ONVIF device ditemukan: ${rinfo.address}:${rinfo.port}`);
                
                // Extract informasi dari response
                const ipMatch = message.match(/XAddrs>([^<]+)/);
                const nameMatch = message.match(/<wsdp:FriendlyName>([^<]+)/);
                
                devices.push({
                    ip: rinfo.address,
                    port: rinfo.port,
                    xaddrs: ipMatch ? ipMatch[1] : 'Unknown',
                    name: nameMatch ? nameMatch[1] : 'Unknown Device',
                    raw: message
                });
            }
        });
        
        client.on('error', (err) => {
            console.log('❌ ONVIF discovery error:', err.message);
            resolve(devices);
        });
        
        // Bind ke port 3702 (ONVIF discovery port)
        try {
            client.bind(3702, () => {
                console.log('📡 Broadcasting ONVIF discovery probe...');
                
                // Send to multicast address
                client.setBroadcast(true);
                client.setMulticastTTL(128);
                
                // ONVIF multicast address
                client.send(probeMessage, 0, probeMessage.length, 3702, '239.255.255.250', (err) => {
                    if (err) {
                        console.log('❌ Gagal kirim probe:', err.message);
                        resolve(devices);
                    }
                });
                
                // Wait for responses
                setTimeout(() => {
                    client.close();
                    resolve(devices);
                }, DISCOVERY_TIMEOUT);
            });
        } catch (err) {
            console.log('❌ Tidak bisa bind ke port 3702:', err.message);
            console.log('💡 Mencoba direct connection ke IP target...');
            
            // Fallback: coba direct ONVIF connection
            testDirectONVIF();
            resolve(devices);
        }
    });
}

// Test direct ONVIF connection ke IP yang kita tahu
async function testDirectONVIF() {
    console.log('\n🎯 Testing direct ONVIF connection...\n');
    
    const targets = [];
    
    if (targets.length === 0) {
        console.log('Tidak ada target testing yang didefinisikan.');
        return;
    }

    for (const target of targets) {
        console.log(`Testing ${target.name} (${target.ip}:${target.port})...`);
        
        // Test ONVIF ports
        const onvifPorts = [80, 8080, 8081, 8082, 8000, 8888, 8899];
        
        for (const port of onvifPorts) {
            process.stdout.write(`  Port ${port}: `);
            
            const result = await testONVIFPort(target.ip, port);
            
            if (result.available) {
                console.log('✅ ONVIF available');
                console.log(`   🎉 ONVIF URL: http://${target.ip}:${port}/onvif/device_service`);
                
                // Coba get RTSP URL via ONVIF
                await getONVIFStreamURI(target.ip, port);
                break;
            } else {
                console.log('❌ Not available');
            }
        }
    }
}

// Test koneksi ke ONVIF port
function testONVIFPort(ip, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        
        socket.on('connect', () => {
            socket.destroy();
            resolve({ available: true });
        });
        
        socket.on('error', () => {
            resolve({ available: false });
        });
        
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ available: false });
        });
        
        socket.connect(port, ip);
    });
}

// Get stream URI via ONVIF
async function getONVIFStreamURI(ip, port) {
    console.log(`\n📹 Mencoba get stream URI via ONVIF...`);
    
    // ONVIF GetStreamURI request
    const streamURIRequest = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <soap:Header/>
  <soap:Body>
    <trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport>
          <tt:Protocol>RTSP</tt:Protocol>
        </tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>Profile_1</trt:ProfileToken>
    </trt:GetStreamUri>
  </soap:Body>
</soap:Envelope>`;
    
    const auth = Buffer.from('admin:admin').toString('base64');
    
    return new Promise((resolve) => {
        const options = {
            hostname: ip,
            port: port,
            path: '/onvif/device_service',
            method: 'POST',
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'Content-Length': streamURIRequest.length,
                'Authorization': `Basic ${auth}`
            },
            timeout: 5000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (data.includes('rtsp://')) {
                    const uriMatch = data.match(/<tt:Uri>([^<]+)/);
                    if (uriMatch) {
                        console.log(`   ✅ RTSP URL ditemukan: ${uriMatch[1]}`);
                    }
                } else {
                    console.log('   ❌ Tidak dapat RTSP URL dari ONVIF');
                }
                resolve();
            });
        });
        
        req.on('error', () => {
            console.log('   ❌ ONVIF request failed');
            resolve();
        });
        
        req.on('timeout', () => {
            req.destroy();
            console.log('   ❌ ONVIF request timeout');
            resolve();
        });
        
        req.write(streamURIRequest);
        req.end();
    });
}

// Generate UUID untuk ONVIF
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Main function
async function main() {
    console.log('🔍 ONVIF Auto-Discovery Tool');
    console.log('Mencari kamera dengan protocol ONVIF...\n');
    
    const devices = await discoverONVIFDevices();
    
    if (devices.length === 0) {
        console.log('\n⚠️  Tidak ada ONVIF device yang ditemukan via multicast');
        console.log('💡 Mencoba direct connection...');
    } else {
        console.log(`\n✅ Ditemukan ${devices.length} ONVIF device(s)`);
        devices.forEach(device => {
            console.log(`   IP: ${device.ip}`);
            console.log(`   Name: ${device.name}`);
        });
    }
}

main();