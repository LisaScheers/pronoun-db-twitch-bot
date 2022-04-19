// import twitch
import { ChatClient } from "twitch-chat-client";
import { RefreshableAuthProvider, StaticAuthProvider } from "twitch-auth";
import { promises as fs, existsSync } from "fs";
import * as dotenv from "dotenv";
import { TwitchPrivateMessage } from "twitch-chat-client/lib/StandardCommands/TwitchPrivateMessage";
import { ApiClient } from "twitch";
import { createClient } from "redis";
import axios from "axios";
dotenv.config();
const configFile = "/secrets/config.json";
const tokensFile = "/secrets/tokens.json";

// redis client
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

// twitch bot init

const clientId = process.env.CLIENT_ID;
// check if client id is set
if (!clientId) {
  console.error("Please set the CLIENT_ID environment variable");
  process.exit(1);
}
const clientSecret = process.env.CLIENT_SECRET;
// check if client secret is set
if (!clientSecret) {
  console.error("Please set the CLIENT_SECRET environment variable");
  process.exit(1);
}

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiryTimestamp: number | null;
}

var tokenData: TokenData;

try {
  tokenData = JSON.parse(await fs.readFile(tokensFile, "utf-8"));
} catch (e) {
  console.error("Could not read tokens.json");
  console.info("Creating new tokens.json");
  const newTokenData: TokenData = {
    accessToken: "ACCESS_TOKEN",
    refreshToken: "REFRESH_TOKEN",
    expiryTimestamp: null,
  };
  //create directory if it doesn't exist
  await fs.mkdir("/secrets", { recursive: true });
  await fs.writeFile(tokensFile, JSON.stringify(newTokenData));
  process.exit(1);
}
const authProvider = new RefreshableAuthProvider(
  new StaticAuthProvider(clientId, tokenData.accessToken),
  {
    clientSecret,
    refreshToken: tokenData.refreshToken,
    expiry:
      tokenData.expiryTimestamp === null
        ? null
        : new Date(tokenData.expiryTimestamp),
    onRefresh: async ({ accessToken, refreshToken, expiryDate }) => {
      const newTokenData: TokenData = {
        accessToken,
        refreshToken,
        expiryTimestamp: expiryDate === null ? null : expiryDate.getTime(),
      };
      await fs.writeFile(
        "./tokens.json",
        JSON.stringify(newTokenData, null, 4),
        "utf-8"
      );
    },
  }
);

// get config
const config = await readConfig();

// create chat client
const chatClient = new ChatClient(authProvider, {
  channels: [...config.users],
  botLevel: "none",
});
const apiClient = new ApiClient({ authProvider });
// connect to twitch chat
await chatClient.connect();
console.log("Connected to Twitch chat");

// join channel
// listen for messages
chatClient.onMessage(async (channel, user, message, msg) => {
  // if prefix is !
  if (message.startsWith("!")) {
    // switch case
    switch (message.toLowerCase().split(" ")[0]) {
      // !pn // pronoun
      case "!pn":
        handlePronounCommand(channel, user, message, msg);
        break;
    }
  }
});

// handle pronoun command
async function handlePronounCommand(
  channel: string,
  user: string,
  message: string,
  msg: TwitchPrivateMessage
) {
  // validate message must contain a username
  if (!message.split(" ")[1]) {
    chatClient.sendRaw(
      `@reply-parent-msg-id=${msg.tags.get(
        "id"
      )} PRIVMSG ${channel} :Please provide a username`
    );
    return;
  }
  // get username
  const username = message.split(" ")[1];
  // parse username remove @
  const parsedUsername = username.replace("@", "");
  // get user data
  try {
    const userData = await apiClient.helix.users.getUserByName(parsedUsername);
    // get user id
    if (!userData) throw new Error("User not found");
    const userId = userData?.id;
    // get pronoun
    let { pronoun, error } = await getPronoun(userId!, userData.name);
    // send message
    if (!pronoun) {
      // if pronoun is not found
      chatClient.sendRaw(
        `@reply-parent-msg-id=${msg.tags.get(
          "id"
        )} PRIVMSG ${channel} :${error}`
      );
    }
    chatClient.sendRaw(
      `@reply-parent-msg-id=${msg.tags.get("id")} PRIVMSG ${channel} : @${
        userData.displayName
      } uses ${pronoun} pronouns`
    );
  } catch (e) {
    chatClient.sendRaw(
      `@reply-parent-msg-id=${msg.tags.get(
        "id"
      )} PRIVMSG ${channel} :User not found`
    );
  }
}

//get pronoun from redis cashe
async function getPronoun(
  userId: string,
  username: string
): Promise<{ pronoun?: string; error?: string }> {
  try {
    if (!redis.isOpen) await redis.connect();
    const pronoun = await redis.get(userId);
    if (pronoun) {
      return { pronoun };
    } else {
      // try
      try {
        const pronoun = await getPronounFromPronounDB(userId, username);
        //expires in 1 day
        redis.set(userId, pronoun);
        redis.expire(userId, 86400);
        return { pronoun };
      } catch (e) {
        console.error(e);

        // whisper user to set pronouns
        chatClient.whisper(
          username,
          "Please set your pronouns over at https://pronoundb.org/"
        );
        return { error: "pronouns not found for user " + username };
      }
    }
  } catch (e) {
    console.error(e);
    // whisper user to set pronouns
    chatClient.whisper(
      username,
      "Please set your pronouns over at https://pronoundb.org/"
    );
    return { error: "pronouns not found for user " + username };
  }
}

async function getPronounFromPronounDB(userId: string, username: string) {
  // https://pronoundb.org/api/v1/lookup?id={username}&platform=twitch
  const url = `https://pronoundb.org/api/v1/lookup?id=${userId}&platform=twitch`;
  const response = await axios.get(url);
  const data = await response.data;
  console.log("data from pndb: ", data);
  // {"pronouns":"st"}
  const pronoun = data.pronouns;
  if (pronoun != "unspecified") {
    return pronouns[pronoun];
  }

  // https://pronouns.alejo.io/api/users/
  const url2 = `https://pronouns.alejo.io/api/users/${username}`;
  const response2 = await axios.get(url2);
  const data2 = await response2.data;
  console.log("data from alejo ", data2);
  // [{"id":"195304642","login":"lisascheers","pronoun_id":"shethem"}]
  if (data2.length > 0) {
    const pronoun = data2[0].pronoun_id;
    return pronouns[pronoun];
  }
  throw new Error("No pronoun found");
}

// map pronouns pronoundb.org
const pronouns: { [name: string]: string } = {
  hh: "he/him",
  hi: "he/it",
  hs: "he/she",
  ht: "he/they",
  ih: "it/him",
  ii: "it/its",
  is: "it/she",
  it: "it/they",
  shh: "she/he",
  sh: "she/her",
  si: "she/it",
  st: "she/they",
  th: "they/he",
  ti: "they/it",
  ts: "they/she",
  tt: "they/them",
  any: "Any ",
  other: "Other ",
  ask: "Ask me my ",
  avoid: "Avoid pronouns, use my name",
  aeaer: "Ae/Aer",
  eem: "E/Em",
  faefaer: "Fae/Faer",
  hehim: "He/Him",
  heshe: "He/She",
  hethem: "He/They",
  itits: "It/Its",
  perper: "Per/Per",
  sheher: "She/Her",
  shethem: "She/They",
  theythem: "They/Them",
  vever: "Ve/Ver",
  xexem: "Xe/Xem",
  ziehir: "Zie/Hir",
};

chatClient.onWhisper(async (user, message, msg) => {
  // check if message is !join
  if (message.toLowerCase() === "!join") {
    // join channel
    try {
      await chatClient.join(user);
    } catch (e) {
      console.error(e);
    }
    // read current configfile
    const config = await readConfig();
    // add user to config
    config.users.push(user);
    // write configfile
    await writeConfig(config);
    // send message
    chatClient.whisper(user, "Joined channel");
  }
});

interface Config {
  users: string[];
}

// read config file
async function readConfig(): Promise<Config> {
  // if file does not exist create it
  if (!existsSync(configFile)) await writeConfig({ users: [] });
  const config = await fs.readFile(configFile, "utf8");
  return JSON.parse(config);
}

// write config file
async function writeConfig(config: Config): Promise<void> {
  await fs.writeFile(configFile, JSON.stringify(config));
}
