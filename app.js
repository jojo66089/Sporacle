require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const querystring = require('querystring');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const SpotifyWebApi = require('./Spotify-web-api');

const OpenAI = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = 'http://localhost:8888/callback';

const generateRandomString = (length) => {
  return crypto
    .randomBytes(60)
    .toString('hex')
    .slice(0, length);
}

const stateKey = 'spotify_auth_state';

const app = express();

app.use(express.static(__dirname + '/public'))
  .use(cors())
  .use(cookieParser())
  .use(bodyParser.json());

app.get('/login', function(req, res) {
  const state = generateRandomString(16);
  res.cookie(stateKey, state);

  const scope = 'user-read-private user-read-email user-top-read';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', async function(req, res) {
  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    res.clearCookie(stateKey);
    const authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      data: querystring.stringify({
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
      }
    };

    try {
      const response = await axios.post(authOptions.url, authOptions.data, { headers: authOptions.headers });
      if (response.status === 200) {
        const access_token = response.data.access_token,
          refresh_token = response.data.refresh_token;

        const options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token }
        };

        const userInfo = await axios.get(options.url, { headers: options.headers });
        console.log(userInfo.data);

        res.redirect('/#' +
          querystring.stringify({
            access_token: access_token,
            refresh_token: refresh_token
          }));
      }
    } catch (error) {
      res.redirect('/#' +
        querystring.stringify({
          error: 'invalid_token'
        }));
    }
  }
});

// Exponential backoff retry logic
const exponentialBackoff = async (fn, retries = 5, delay = 1000) => {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (error) {
      if (error.response && error.response.status === 429) {
        attempt++;
        const backoffDelay = delay * Math.pow(2, attempt);
        console.log(`Rate limit hit. Retrying in ${backoffDelay} ms...`);
        await new Promise(res => setTimeout(res, backoffDelay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Exceeded maximum retries');
};

app.post('/generate-response', async function(req, res) {
  const { trackNames, artistNames } = req.body;

  if (!trackNames || !Array.isArray(trackNames) || !artistNames || !Array.isArray(artistNames)) {
    return res.status(400).send({ error: 'Track names and artist names are required and should be arrays' });
  }

  const userQuery = `Generate a psychological reading based on the following top tracks and artists. You are to do this reading in a very astrological and superstitious manner, like an oracle reading. Make the reading like a personality test, but also try to make predictions and mystic relevations like including details about past, present, and future. DO NOT USE bold lettering nor anything other than plain text. You may use emojis, but that is about it. Here are the person's top tracks: ${trackNames.join(', ')}. And here are their top artists: ${artistNames.join(', ')}`;

  try {
    const response = await exponentialBackoff(async () => {
      return await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an oracle providing astrological and divination-type readings based on the users Spotify top tracks and artists. Be detailed, specific, and creative. You are to basically try and read this person based off their listening patterns. You are allowed to make guesses about this person, almost like how Tarot-cards assume Past,Present, and future, and you are allowed to make predicitons about this person our give them divine guidance. Try and include the vibes of the Songs or the artists based off the information you know about them, and try to incorporate frequencies to make the claims sound more grounded and true. Give the illusion that this is a real divination reading. Be straightforward and try not to be all fluttery with your words. You are direct, cutthroat, and you speak with certainty. You reveal good things and also things that the person might struggle with, but you offer guidance and solutions based of the vibes of their listening patterns. Also refrain from using dear seeker and other adressions like that.' },
          { role: 'user', content: userQuery }
        ],
        max_tokens: 2000,
        temperature: 0.9,
        n: 1
      });
    });

    console.log('Full API response:', response); // Debug log the full response

    res.send({ response: response.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: 'Failed to generate response' });
  }
});

app.get('/refresh_token', function(req, res) {
  const refresh_token = req.query.refresh_token;
  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
    },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
  };

  axios.post(authOptions.url, querystring.stringify(authOptions.form), { headers: authOptions.headers })
    .then(response => {
      if (response.status === 200) {
        const access_token = response.data.access_token,
          refresh_token = response.data.refresh_token;
        res.send({
          'access_token': access_token,
          'refresh_token': refresh_token
        });
      }
    })
    .catch(error => {
      console.error(error);
      res.status(500).send({ error: 'Failed to refresh token' });
    });
});

app.get('/api/top-tracks-and-artists', async function(req, res) {
  const { access_token } = req.query;

  if (!access_token) {
    return res.status(400).send({ error: 'Access token is required' });
  }

  SpotifyWebApi.setAccessToken(access_token);

  try {
    const topTracksData = await SpotifyWebApi.getMyTopTracks({ limit: 10, time_range: 'medium_term' });
    const topArtistsData = await SpotifyWebApi.getMyTopArtists({ limit: 10, time_range: 'medium_term' });
    
    res.send({
      topTracks: topTracksData.body,
      topArtists: topArtistsData.body
    });
  } catch (error) {
    console.error('Failed to fetch top tracks or top artists', error);
    res.status(500).send({ error: 'Failed to fetch top tracks or top artists' });
  }
});

console.log('Listening on 8888');
app.listen(8888);
