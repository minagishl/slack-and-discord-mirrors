import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  type TextChannel,
  type Sticker,
} from 'discord.js';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'fs';
import sharp from 'sharp';
import axios from 'axios';
import { URL } from 'url';
import { WebClient } from '@slack/web-api';
import getFiles from '~/utils/getFiles';
import keepAlive from './utils/keepAlive';

// Load the environment variables
dotenv.config();

interface Env {
  TOKEN: string;
  SLACKTOKEN: string;
  DISCORDCHANNEL: string;
  SLACKCHANNEL: string;
}

const env: Env = {
  TOKEN: process.env.TOKEN ?? '',
  SLACKTOKEN: process.env.SLACKTOKEN ?? '',
  DISCORDCHANNEL: process.env.DISCORDCHANNEL ?? '',
  SLACKCHANNEL: process.env.SLACKCHANNEL ?? '',
};

if (
  env.TOKEN === '' ||
  env.SLACKTOKEN === '' ||
  env.DISCORDCHANNEL === '' ||
  env.SLACKCHANNEL === ''
) {
  console.error(
    new Error(
      'One or more required environment variables are not set, undefined, or empty.',
    ),
  );
  process.exit(1);
}

// Keep the bot alive
if (process.env.KEEP_ALIVE === 'true') {
  void keepAlive();
}

const client: Client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

interface Mirror {
  discord: string;
  slack: string;
}

interface State {
  lastMessage: string;
}

const config = {
  discordToken: env.TOKEN,
  slackToken: env.SLACKTOKEN,
  mirrors: [
    {
      discord: env.DISCORDCHANNEL,
      slack: env.SLACKCHANNEL,
    },
  ] as Mirror[],
};

const state: State = {
  lastMessage: '0',
};

const slackClient = new WebClient(config.slackToken);

client.once('ready', async () => {
  console.log('Discord bot is ready');
  await initializeState();
  await startSlackBot(client);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  for (const mirror of config.mirrors) {
    if (mirror.discord === message.channel.id) {
      let stickerUrl: URL | undefined;
      let sticker: Sticker | undefined;
      if (message.stickers.size > 0) {
        sticker = message.stickers.first();
        if (typeof sticker !== 'undefined') {
          stickerUrl = new URL(
            `https://media.discordapp.net/stickers/${sticker.id}?size=160`,
          );
        }
      }

      console.log('Posting message to Slack');
      const messageContent = message.content;
      const text = `${message.author.username}: ${messageContent}`;

      if (message.attachments.size === 0) {
        if (messageContent !== '') {
          await slackClient.chat.postMessage({
            text,
            channel: mirror.slack,
          });
        }

        // If there is a sticker, upload it to Slack
        if (sticker?.format === 1) {
          // Sticker format 1 is a PNG image
          await slackClient.files.uploadV2({
            channel_id: mirror.slack,
            file: await getImageBuffer(stickerUrl?.toString() ?? ''),
            filename: 'stecker.png',
          });
        }
      } else {
        const attachment = message.attachments.first();
        if (typeof attachment !== 'undefined') {
          const url = attachment.url;
          console.log('downloading ' + url);
          const response = await axios.get(url, { responseType: 'stream' });
          const parsedUrl = new URL(url);
          const ext = path.extname(parsedUrl.pathname);

          const filePath = `./input${ext}`;
          const writer = fs.createWriteStream(filePath);
          response.data.pipe(writer);

          writer.on('finish', () => {
            const fileData = fs.readFileSync(filePath);

            Promise.all([
              slackClient.chat.postMessage({ text, channel: mirror.slack }),
              slackClient.files.upload({
                channels: mirror.slack,
                file: fileData,
                filename: path.basename(filePath),
              }),
            ])
              .then(() => {
                console.log('Message posted and file uploaded successfully.');
              })
              .catch((error) => {
                console.error(
                  'Error posting message or uploading file:',
                  error,
                );
              });
          });
        }
      }
    }
  }
});

async function initializeState(): Promise<void> {
  try {
    const response = await slackClient.conversations.history({
      channel: config.mirrors[0].slack,
      limit: 1,
    });
    const messages = response.messages;
    if (typeof messages !== 'undefined' && messages.length > 0) {
      state.lastMessage = messages[0].ts ?? '0';
    }
  } catch (error) {
    console.error('Error initializing state:', error);
  }
}

async function startSlackBot(discordClient: Client): Promise<void> {
  console.log('Starting Slack bot');

  while (true) {
    try {
      const response = await slackClient.conversations.history({
        channel: config.mirrors[0].slack,
        oldest: state.lastMessage,
      });

      // get the message from the response
      const messages = response.messages;
      if (typeof messages === 'undefined' || messages.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      messages.sort(
        (a, b) => parseFloat(a.ts ?? '0') - parseFloat(b.ts ?? '0'),
      );

      for (const message of messages) {
        if (
          typeof message.subtype !== 'undefined' ||
          typeof state.lastMessage === 'undefined' ||
          typeof message.ts === 'undefined'
        ) {
          continue;
        }

        state.lastMessage = message.ts;

        // If the message doesn't have a user, skip it
        if (typeof message.user === 'undefined') {
          continue;
        }

        const userInfo = await slackClient.users.info({ user: message.user });
        const user = userInfo.user;

        if (typeof user?.is_bot !== 'undefined' && !user.is_bot) {
          console.log('Posting message to Discord');
          const discordChannel = discordClient.channels.cache.get(
            config.mirrors[0].discord,
          ) as TextChannel;

          const text = `${user.real_name}: ${message.text}`;

          if (
            typeof message.files !== 'undefined' &&
            message.files.length > 0
          ) {
            const file = message.files[0];
            const fileUrl = file.url_private_download;

            // If the file URL is undefined, skip the file
            if (typeof fileUrl === 'undefined') {
              continue;
            }

            const response = await axios.get(fileUrl, {
              responseType: 'stream',
              headers: { Authorization: `Bearer ${config.slackToken}` },
            });

            const parsedUrl = new URL(fileUrl);
            const ext = path.extname(parsedUrl.pathname);
            const filePath = `./input${ext}`;

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            writer.on('finish', () => {
              const discordFile = new AttachmentBuilder(
                fs.readFileSync(filePath),
              );
              // Check if the discord channel is undefined
              if (typeof discordChannel === 'undefined') {
                console.error('Discord channel is undefined.');
                return;
              }

              Promise.all([
                // Post the message to the discord channel
                discordChannel.send({
                  content: text,
                  files: [discordFile],
                }),
              ])
                .then(() => {
                  console.log('Message posted and file uploaded successfully.');
                })
                .catch((error) => {
                  console.error(
                    'Error posting message or uploading file:',
                    error,
                  );
                });
            });
          } else {
            // Check if the discord channel is undefined
            if (typeof discordChannel === 'undefined') {
              console.error('Discord channel is undefined.');
              return;
            }

            await discordChannel.send({
              content: text,
            });
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(error);
    }
  }
}

async function getImageBuffer(url: string): Promise<Buffer> {
  try {
    // Get the image from the URL
    const response = await axios({
      url,
      responseType: 'arraybuffer',
    });

    // Convert the response data to a Buffer
    const buffer = Buffer.from(response.data as ArrayBuffer);

    // Process the image with sharp
    const imageBuffer = await sharp(buffer).toBuffer();

    return imageBuffer;
  } catch (error) {
    console.error('Error fetching or processing image:', error);
    throw error;
  }
}

/**
 * Get all the event files and register them with the client.
 */
async function loadEvents(): Promise<void> {
  // Get all the event files
  const eventFiles = await getFiles(path.join(__dirname, '/events'));

  const events = await Promise.all(
    eventFiles.map(async (file) => {
      // Import the event file
      const { default: event } = await import(file);
      if (event?.once === true) {
        return [
          event.name,
          (...args: any[]) => event.execute(...args),
          { once: true },
        ];
      } else {
        return [event.name, (...args: any[]) => event.execute(...args)];
      }
    }),
  );

  events.forEach((event) => {
    if (event[2]?.once === true) {
      client.once(event[0], event[1] as () => void);
    } else {
      client.on(event[0], event[1] as () => void);
    }
  });
}

client.login(process.env.TOKEN).catch((err: any) => {
  console.error(new Error(`Failed to login ${err}`));
});

// Load events
Promise.all([loadEvents()])
  .then(() => {
    // Log a success message when the events are loaded.
    console.log('Successfully loaded events.');
  })
  .catch((err: any) => {
    // Log an error if the events fail to load.
    console.error(new Error(`Failed to load events:\n${err}`));
  });
