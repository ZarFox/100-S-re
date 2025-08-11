// commands.js
export const commands = [
  {
    name: 'ping',
    description: 'Répond pong avec la latence estimée'
  },
  {
    name: 'say',
    description: 'Fait dire un message au bot dans ce salon',
    options: [
      {
        type: 3, // STRING
        name: 'message',
        description: 'Le message à envoyer',
        required: true
      }
    ]
  }
];
