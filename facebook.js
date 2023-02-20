const { workerData, parentPort } = require('worker_threads');
const puppeteer = require('puppeteer');

const sleep = (time) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(true);
    }, time);
  });
};

class FacebookService {
  constructor(cookie, proxy) {
    this.cookie = cookie;
    if (proxy) {
      const proxyParts = proxy.split(':');
      this.proxy = {
        username: proxyParts[2],
        password: proxyParts[3],
        host: proxyParts[0],
        port: proxyParts[1]
      };
    }
  }

  reactionType = {
    LIKE: '1635855486666999',
    LOVE: '1678524932434102',
    CARE: '613557422527858',
    HAHA: '115940658764963',
    WOW: '478547315650144',
    SAD: '908563459236466',
    ANGRY: '444813342392137'
  };
  async createBrowser() {
    // install proxy-chain  "npm i proxy-chain --save"
    const proxyChain = require('proxy-chain');

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=350,600'
    ];

    if (this.proxy) {
      // change username & password
      const oldProxyUrl = `http://${this.proxy.username}:${this.proxy.password}@${this.proxy.host}:${this.proxy.port}`;
      const newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);
      args.push(`--proxy-server=${newProxyUrl}`);
    }

    const browser = await puppeteer.launch({
      headless: false,
      args,
      defaultViewport: {
        width: 450,
        height: 500
      }
    });
    const page = await browser.newPage();
    // Split the cookie header into individual cookies
    const cookies = this.cookie.split(';').map((cookie) => {
      const [name, value] = cookie.split('=');
      return {
        name: name.trim(),
        value: value.trim(),
        domain: '.facebook.com'
      };
    });
    // Add each cookie to the page
    for (const cookie of cookies) {
      await page.setCookie(cookie);
    }

    // Navigate to the website
    this.browser = browser;
    this.page = page;

    return browser;
  }

  async scanPost(targetId) {
    const page = await this.browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (
        req.resourceType() == 'stylesheet' ||
        req.resourceType() == 'font' ||
        req.resourceType() == 'image'
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let posts = [];
    await page.goto(`https://mbasic.facebook.com/${targetId}?v=timeline`, {
      waitUntil: 'load',
      // Remove the timeout
      timeout: 0
    });
    for (let i = 0; i < 3; i++) {
      await sleep(2);
      let newPosts = await page.$$eval('article', (posts) => {
        return posts.map((post) => {
          const postData = JSON.parse(
            post.getAttribute('data-ft')
          );

          const postId = postData?.top_level_post_id;
          const ownerId = postData?.content_owner_id_new;
          return {
            postId,
            ownerId
          };
        });
      });
      newPosts = newPosts.filter(post => post.ownerId === targetId).map(post => post.postId).filter(Boolean);

      posts = [...posts, ...newPosts];

      // Find new elements
      const loadMoreButton = await page.$(
        'a[href*="/profile/timeline/stream/?cursor"]'
      );
      if (!loadMoreButton) {
        break;
      }
      await loadMoreButton.click();
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 0 });
    }
    return {
      uid: targetId,
      posts
    };
  }

  async scanPosts(targetIds) {
    return Promise.all(targetIds.map((targetId) => this.scanPost(targetId)));
  }

  async getIP() {
    await this.page.goto('https://ip.mefibay.com/json');
  }

  async closeBrowser() {
    try {
      await this.browser.close();
    } catch (e) {
      console.log('Can\'t close browser');
    }
  }

  async checkLogin() {
    try {
      await this.page.goto('https://mbasic.facebook.com/login.php', {
        waitUntil: 'load',
        // Remove the timeout
        timeout: 0
      });
      const url = await this.page.evaluate(() => document.location.href);
      if (url.includes('/login.php') || url.includes('checkpoint')) {
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  async reaction(postId, reactionName) {
    const reaction = this.reactionType[reactionName.toUpperCase()];
    await this.page.goto('https://mbasic.facebook.com/' + postId);
    const reactionButton = await this.page.$('a[href*="/reactions/picker/"]');
    if (!reactionButton) {
      console.log('No reaction button found');
      return false;
    }
    await reactionButton.click();

    await this.page.waitForNavigation({ waitUntil: 'networkidle0' });


    const isLiked = await this.page.evaluate(() => {
      let isLiked = false;
      const items = document.querySelectorAll('table[role="presentation"] tr');
      for (const item of items) {
        if (item.children.length === 3) {
          isLiked = true;
          break;
        }
      }
      return isLiked;
    });

    if (isLiked) {
      console.log('Da reaction');
      return false;
    }

    const targetReaction = await this.page.$(
      `a[href*="&reaction_id=${reaction}"]`
    );
    if (!targetReaction) {
      console.log('No reaction button found');
      return false;
    }
    await targetReaction.click();

    // Wait page loaded
    await this.page.waitForNavigation({ waitUntil: 'networkidle0' });
    const helpContactElement = await this.page.$(`a[href*="/help/contact/"]`);
    if (helpContactElement) {
      return false;
    }
    return true;
  }
}

(async () => {
  if (!workerData) {
    return;
  }
  const { command, data } = workerData;

  if (command === 'checkResource') {
    const { cookie, proxy } = data;
    const facebook = new FacebookService(cookie, proxy);
    await facebook.createBrowser();
    const status = await facebook.checkLogin();
    await facebook.closeBrowser();
    return parentPort.postMessage(status);
  }

  if (command === 'login') {
    const { cookie, proxy } = data;
    const facebook = new FacebookService(cookie, proxy);
    await facebook.createBrowser();
    const status = await facebook.checkLogin();
    setTimeout(() => {
      facebook.checkLogin();
    }, 10 * 1000);
    return parentPort.postMessage(status);
  }

  if (command === 'getPosts') {
    const { targetId, resource } = data;
    const { cookie, proxy } = resource;
    const facebook = new FacebookService(cookie, proxy);
    await facebook.createBrowser();
    const isLoggedIn = await facebook.checkLogin();
    if (!isLoggedIn) {
      return parentPort.postMessage(JSON.stringify({
        error: true,
        message: 'cookie_die'
      }));
    }
    const result = await facebook.scanPost(targetId);
    await facebook.closeBrowser();
    return parentPort.postMessage(JSON.stringify(result));
  }


  if (command === 'interact') {
    const { postId, reaction, resource } = data;
    const { cookie, proxy } = resource;
    const facebook = new FacebookService(cookie, proxy);
    await facebook.createBrowser();
    const isLoggedIn = await facebook.checkLogin();
    if (!isLoggedIn) {
      return parentPort.postMessage(JSON.stringify({
        error: true,
        message: 'cookie_die'
      }));
    }
    const result = await facebook.reaction(postId, reaction.toUpperCase());
    await facebook.closeBrowser();
    return parentPort.postMessage(JSON.stringify({
      error: false,
      status: result
    }));
  }
})();

module.exports = FacebookService;
