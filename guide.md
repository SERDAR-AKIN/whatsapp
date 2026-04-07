How It Works
The library works by launching the WhatsApp Web browser application and managing it using Puppeteer to create an instance of WhatsApp Web, thereby mitigating the risk of being blocked. The WhatsApp API client connects through the WhatsApp Web browser app, accessing its internal functions. This grants you access to nearly all the features available on WhatsApp Web, enabling dynamic handling similar to any other Node.js application.



Installation
Before getting started with whatsapp-web.js, it's essential for you to install Node.js and whatsapp-web.js itself on your machine. Please note that whatsapp-web.js v1 requires Node v18 or higher.

Installation on no-gui systems
If you want to install whatsapp-web.js on a system without a GUI, such as a linux server image, and you need puppeteer to emulate the Chromium browser, there are a few additional steps you'll need to take.

First, you'll need to install dependencies required by puppeteer, such as the necessary libraries and tools for running a headless Chromium browser.

sudo apt install -y gconf-service libgbm-dev libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget

After installing these dependencies, you can proceed with installing whatsapp-web.js and puppeteer as usual. When puppeteer installs, it will download a version of Chromium suitable for headless environments.


Create your project folder
TIP

Setup via Terminal

Depending on your preference, you can create a new project folder using the terminal.

The folder is created on your directory you are currently located in. You can navigate to the location of your choice on your machine via cd path/to/your/folder and create a new folder.

mkdir wwebjs-bot
cd wwebjs-bot

Navigate to the location of your choice on your machine and create a new folder named wwebjs-bot (or whatever you want) for your project. Next you'll need to open your terminal in your folder.

TIP

If you use Visual Studio Code, you can press Ctrl + ` to open its integrated terminal.

With the terminal open, run the node -v command to ensure that you've successfully installed Node.js. If it outputs v18 or higher, you're all set! If not, you should consider reinstalling Node.js and following the installation steps again.

npm init

This command creates a package.json file for your project, which will keep track of the dependencies your project uses, as well as other information. When you run it, it will ask you a series of questions. You should fill them out according to your project's needs. If you're unsure about something or want to skip it entirely, you can leave it blank and press Enter.

TIP

For a quick start, simply run the following command to automatically fill in all the details for you.

npm init -y

Example `package.json` file
{
  "name": "wwebjs-bot",
  "version": "1.0.0",
  "description": "This is a simple example for this library.",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "",
  "license": "ISC"
}

Once you've completed that step, you're all set to install whatsapp-web.js!

Installing whatsapp-web.js
Now that you have your project folder set up, you can install whatsapp-web.js. To do this, open your terminal again within your folder and execute the following command:

npm install whatsapp-web.js

In your console, the downloading progress will now be displayed. Once the download is completed, you'll be ready to start with your project.


Create the main file

In this section, we will create the main file for your bot. This file will be the entry point for your bot, and it will contain the code that will start the bot and handle incoming messages. We suggest that you save the file as main.js, but you may name it whatever you wish.

Here's the base code to get you started:
const { Client } = require('whatsapp-web.js');

// Create a new client instance
const client = new Client();

// When the client is ready, run this code (only once)
client.once('ready', () => {
    console.log('Client is ready!');
});

// When the client received QR-Code
client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
});

// Start your client
client.initialize();


QR-Code generation
Since whatsapp-web.js works by running WhatsApp Web in the background and automating its interaction, you'll need to authorize the client by scanning a QR code from WhatsApp on your phone. Right now, we're just logging the text representation of that QR code to the console. Let's install and use qrcode-terminal so we can render the QR code and scan it with our phone to authorize the client.

npm install qrcode-terminal

And now we'll modify our code to use this new module:

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client();

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('qr', qr => {
    qrcode.generate(qr, {small: true});
});

client.initialize();


Our modification now results in the QR code being displayed in the terminal upon startup. From that moment onward, the QR code will be regenerated every 30 seconds until it's scanned with your mobile device. To authorize the client, open WhatsApp on your phone, go to the settings, and scan the QR code. After the scan, the client should be authorized, and you'll see a Client is ready! message printed out in the terminal.


Run your bot

To run your bot, open your terminal and, simply execute node main.js in your terminal. If you've followed all the steps correctly, you should now have a connected client to WhatsApp Web.

TIP

For a quicker way to run your bot, open your package.json file and modify the main property to main.js. Additionally, include a start script in the scripts field. This will enable you to run your bot by executing npm start in your terminal.

"main": "main.js",
"scripts": {
  "start": "node ."
},

After closing the process with Ctrl + C, you can press the up arrow on your keyboard to bring up the latest commands you've run. This will allow you to quickly run your bot again by pressing Enter.

Listening for messages

To listen for incoming messages, the client needs to listen for the message event. When a message is received, it emits a Message object in response, which provides information about the message. In this example, we aim to receive the message and log it to the console. Here's how you can do it:

// Listening to all incoming messages
client.on('message_create', message => {
	console.log(message.body);
});

Replying to messages
To reply to a message, you can use the sendMessage method. This method accepts a string as a parameter, which will be sent as a message. This capability also allows you to create commands. Here's an example of a simple ping/pong command:

client.on('message_create', message => {
	if (message.body === '!ping') {
		// send back "pong" to the chat the message was sent in
		client.sendMessage(message.from, 'pong');
	}
});

The messages object contains also a reply() method, which allows you to directly reply to a message. This method also require a string as a parameter, which will be sent as a message.

client.on('message_create', message => {
	if (message.body === '!ping') {
		// reply back "pong" directly to the message
		message.reply('pong');
	}
});

In this case, notice that we didn't have to specify which chat we were sending the message to.

Authentication
By default, whatsapp-web.js does not save session information. This means that you would have to scan the QR-Code to reauthenticate every time you restart the client. If you'd like to persist the session, you can pass an authStrategy as a client option. The library provides a few authentication strategies to choose from, but you can also choose to extend them or build your own.

WARNING

To ensure proper functioning of Puppeteer on no-gui systems, include the no-sandbox flag into the launch command within the configuration. Additionally, if your program runs with root privileges, remember to include the --disable-setuid-sandbox flag, as Chromium doesn't support running as root without a sandbox by default due to security reasons:

const client = new Client({
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

TIP

For most usage cases, we would recommend the LocalAuth strategy because it is the easiest to use. However, you can also use the RemoteAuth strategy for more flexibility and customization.

NoAuth Strategy

This is the default authStrategy used when you don't provide one. It does not provide any means of saving and restoring sessions. You can set this if you'd like to be explicit about getting a fresh session every time the client is restarted.

const { Client, NoAuth } = require('whatsapp-web.js');

const client = new Client();

// equivalent to:
const client = new Client({
    authStrategy: new NoAuth()
});

LocalAuth Strategy

WARNING

LocalAuth requires a persistent filesystem to be able to restore sessions. This means that out of the box it is not compatible with hosts that provide ephemeral file systems, such as Heroku.

This strategy enables session-restore functionality by passing a persistent user data directory to the browser. This means that other data, such as message history when using a multidevice-enabled account, will also be persisted and restored.

const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth()
});

Location Path
By default, the relevant session files are stored under a .wwebjs_auth directory. However, you can change this by specifying the dataPath option when instantiating LocalAuth Strategy:

const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: 'yourFolderName'
    })
});

This will create a yourFolderName folder with a stored session.

Multiple Sessions
If you're interested in using multiple clients belonging to different sessions, you can pass a clientId to segregate them from each other. This is useful when you want to run multiple clients at the same time.

const { Client, LocalAuth } = require('whatsapp-web.js');

const client1 = new Client({
    authStrategy: new LocalAuth({
    clientId: "client-one" })
});

const client2 = new Client({
    authStrategy: new LocalAuth({
    clientId: "client-two" })
});


RemoteAuth Strategy
The RemoteAuth strategy allows you to save the WhatsApp Multi-Device session in a remote database. Instead of relying on a persistent file system, RemoteAuth can efficiently save, extract, and restore sessions. It also generates periodic backups to ensure that the saved session is always in sync and avoids data loss.

const { Client, RemoteAuth } = require('whatsapp-web.js');

const store = new MongoStore({ mongoose: mongoose });
const client = new Client({
    authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000
    })
});

Remote Stores
Stores are external-independent database plugins that enable storing the session into different databases. To work with RemoteAuth, new stores must implement the following interface.

await store.sessionExists({session: 'yourSessionName'});

You can either implement your own store or use already implemented ones.

MongoDB Store
Before you can use this Auth strategy you need to install the wwebjs-mongo module in your terminal:

npm install wwebjs-mongo


Once the package is installed, you have to import it and pass it to the RemoteAuth strategy as follows:

const { Client, RemoteAuth } = require('whatsapp-web.js');

// Require database
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');

// Load the session data
mongoose.connect(process.env.MONGODB_URI).then(() => {
    const store = new MongoStore({ mongoose: mongoose });
    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        })
    });

    client.initialize();
});


AWS S3 Store
Before you can use this Auth strategy you need to install the wwebjs-aws-s3 module in your terminal:

npm install wwebjs-aws-s3

Once the package is installed, you have to import it and pass it to the RemoteAuthstrategy as follows:

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { AwsS3Store } = require('wwebjs-aws-s3');
const {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const s3 = new S3Client({
    region: 'AWS_REGION',
    credentials: {
        accessKeyId: 'AWS_ACCESS_KEY_ID',
        secretAccessKey: 'AWS_SECRET_ACCESS_KEY'
    }
});

const putObjectCommand = PutObjectCommand;
const headObjectCommand = HeadObjectCommand;
const getObjectCommand = GetObjectCommand;
const deleteObjectCommand = DeleteObjectCommand;

const store = new AwsS3Store({
    bucketName: 'example-bucket',
    remoteDataPath: 'example/path/',
    s3Client: s3,
    putObjectCommand,
    headObjectCommand,
    getObjectCommand,
    deleteObjectCommand
});

const client = new Client({
    authStrategy: new RemoteAuth({
        clientId: 'yourSessionName',
        dataPath: 'yourFolderName',
        store: store,
        backupSyncIntervalMs: 600000
    })
});

Session Saved
After the initial QR scan to link the device, RemoteAuth takes about 1 minute to successfully save the WhatsApp session into the remote database, therefore the ready event does not mean the session has been saved yet. In order to listen to this event, you can now use the following:

client.on('remote_session_saved', () => {
    // Do Stuff...
});

Platform Compatibility
Status	OS
✅	MacOS
✅	Windows
✅	Ubuntu 20.04 (Heroku Compatible)


Detailed documentation: https://docs.wwebjs.dev/