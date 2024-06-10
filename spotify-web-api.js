'use strict';

const SpotifyWebApi = require('spotify-web-api-node');

// Create the api object with the credentials
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: 'http://localhost:8888/callback'
});

module.exports = spotifyApi;

