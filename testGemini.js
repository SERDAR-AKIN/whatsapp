const { spawn } = require('child_process');

async function test() {
    return new Promise((resolve, reject) => {
        const child = spawn('gemini', ['-p', 'Bana {"status": "ok"} şeklinde sadece JSON döndür.']);
        
        let stdoutData = '';
        let stderrData = '';

        child.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        child.on('close', (code) => {
            resolve({ code, stdoutData, stderrData });
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

test().then(console.log).catch(console.error);
