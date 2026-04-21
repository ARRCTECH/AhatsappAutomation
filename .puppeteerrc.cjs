const { join } = require('path');

module.exports = {
    cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
    chrome: {
        skipDownload: false,
    },
    executablePath: '/opt/render/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome'
};