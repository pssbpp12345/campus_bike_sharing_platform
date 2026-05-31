window.API_BASE_URL = 'https://campus-bike-sharing-backend.onrender.com/api';

window.apiUrl = function(path) {
  if (!path) return window.API_BASE_URL;
  if (path.startsWith('http')) return path;
  if (path.startsWith('/api/')) return window.API_BASE_URL + path.replace('/api', '');
  if (path.startsWith('/')) return window.API_BASE_URL + path;
  return window.API_BASE_URL + '/' + path;
};
