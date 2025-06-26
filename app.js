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

// Check required environment variables
if (!client_id || !client_secret || !process.env.OPENAI_API_KEY) {
  console.warn('Warning: One or more required environment variables are not set.');
}

const generateRandomString = (length) => {
  return crypto
    .randomBytes(60)
    .toString('hex')
    .slice(0, length);
};

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
    return res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  }

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

      // Only log minimal info
      const userInfo = await axios.get(options.url, { headers: options.headers });
      console.info('User logged in:', userInfo.data.id);

      return res.redirect('/#' +
        querystring.stringify({
          access_token: access_token,
          refresh_token: refresh_token
        }));
    } else {
      return res.redirect('/#' +
        querystring.stringify({
          error: 'invalid_token'
        }));
    }
  } catch (error) {
    console.error('Callback error:', error?.response?.data || error.message);
    return res.redirect('/#' +
      querystring.stringify({
        error: 'invalid_token'
      }));
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
        console.info(`Rate limit hit. Retrying in ${backoffDelay} ms...`);
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

  const userQuery = `Generate a psychological reading based on the following top tracks and artists. You are to do this reading in a very astrological and superstitious manner, like an oracle reading. Tracks: ${trackNames.join(', ')}. Artists: ${artistNames.join(', ')}.`;

  try {
    const response = await exponentialBackoff(async () => {
      return await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an oracle providing astrological and divination-type readings based on the user\'s Spotify top tracks and artists. Be detailed, specific, and creative.' },
          { role: 'user', content: userQuery }
        ],
        max_tokens: 2000,
        temperature: 0.9,
        n: 1
      });
    });

    // Only log that a response was generated, not the full response
    console.info('OpenAI response generated for tracks:', trackNames.length, 'artists:', artistNames.length);

    res.send({ response: response.choices[0].message.content });
  } catch (error) {
    console.error('OpenAI error:', error?.response?.data || error.message);
    res.status(500).send({ error: 'Failed to generate response. Please try again.' });
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
          new_refresh_token = response.data.refresh_token || refresh_token;
        res.send({
          'access_token': access_token,
          'refresh_token': new_refresh_token
        });
      } else {
        res.status(500).send({ error: 'Failed to refresh token' });
      }
    })
    .catch(error => {
      console.error('Refresh token error:', error?.response?.data || error.message);
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
    console.error('Failed to fetch top tracks or top artists:', error?.response?.data || error.message);
    res.status(500).send({ error: 'Failed to fetch top tracks or top artists' });
  }
});

// Health check route
app.get('/', (req, res) => {
  res.send('Sporacle backend is running.');
});

// 404 handler for unknown endpoints
app.use((req, res) => {
  res.status(404).send({ error: 'Endpoint not found' });
});

console.info('Listening on 8888');
app.listen(8888);
