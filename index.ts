import { Server, Socket } from 'net';
import * as crypto from 'crypto';

const server = new Server();
const sseClients: Set<Socket> = new Set();

server.on('connection', (socket: Socket) => {
	console.log('New connection');

	socket.on('data', (data: Buffer) => {
		console.log('Data received:', data.toString('utf-8'));

		if (isWebSocketHandshake(data)) {
			handleWebSocketHandshake(data, socket);
		} else if (isWebSocketFrame(data)) {
			handleWebSocketFrames(data, socket);
		} else {
			handleHttpRequest(data, socket);
		}
	});

	socket.on('end', () => {
		console.log('Connection ended');
		sseClients.delete(socket);
	});

	socket.on('error', (error: Error) => {
		console.error('Error:', error);
	});

	socket.on('close', () => {
		console.log('Connection closed');
		sseClients.delete(socket);
	});

	socket.on('timeout', () => {
		console.log('Connection timeout');
	});
});

server.listen(3000, () => {
	console.log('Server is running on port 3000');
	setInterval(() => {
		// Send different types of SSE messages
		sendSseMessage({ event: 'ping', data: `Ping event at ${new Date().toISOString()}` });
		sendSseMessage({ data: `Server time: ${new Date().toISOString()}` });
		sendSseMessage({ id: `${Date.now()}` });
		sendSseMessage({ retry: '3000' });
	}, 5000);
});

const httpStatusMessages: { [key: number]: string } = {
	200: 'OK',
	201: 'Created',
	202: 'Accepted',
	204: 'No Content',
	301: 'Moved Permanently',
	302: 'Found',
	304: 'Not Modified',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	500: 'Internal Server Error',
	501: 'Not Implemented',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
};

function buildStatusLine(status: number): string {
	const message = httpStatusMessages[status] || 'Unknown Status';
	return `HTTP/1.1 ${status} ${message}\r\n`;
}

function buildHeaders(headers: { [key: string]: string }): string {
	return (
		Object.entries(headers)
			.map(([key, value]) => `${key}: ${value}`)
			.join('\r\n') + '\r\n'
	);
}

function buildResponse(status: number, headers: { [key: string]: string }, body: string): string {
	const statusLine = buildStatusLine(status);
	const headerLines = buildHeaders(headers);
	return `${statusLine}${headerLines}\r\n${body}`;
}

function handleHttpRequest(data: Buffer, socket: Socket): void {
	const request = data.toString('utf-8');
	const [requestLine, ...headerLines] = request.split('\r\n');
	const [method, path] = requestLine.split(' ');

	let status: number;
	let responseBody: string;
	let responseHeaders: { [key: string]: string } = {
		'Content-Type': 'text/plain',
		'Access-Control-Allow-Origin': '*', // Add CORS header
	};

	if (method === 'GET' && path === '/') {
		status = 200;
		responseBody = 'Hello, world!';
	} else if (method === 'GET' && path === '/websocket') {
		status = 426;
		responseHeaders['Upgrade'] = 'websocket';
		responseHeaders['Connection'] = 'Upgrade';
		responseBody = 'Upgrade Required';
	} else if (method === 'GET' && path === '/serverside-events') {
		handleSseRequest(socket);
		return; // SSE request is handled separately
	} else {
		status = 404;
		responseBody = 'Not Found';
	}

	const response = buildResponse(status, responseHeaders, responseBody);
	socket.write(response);

	if (status !== 426) {
		socket.end();
	}
}

function handleWebSocketHandshake(data: Buffer, socket: Socket): void {
	const headers = data.toString().split('\r\n');
	const key = headers.find((header) => header.startsWith('Sec-WebSocket-Key'))?.split(': ')[1];

	if (key) {
		const acceptKey = generateAcceptValue(key);
		const response =
			'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${acceptKey}\r\n` +
			'Access-Control-Allow-Origin: *\r\n\r\n'; // Add CORS header
		socket.write(response);
	}
}

function generateAcceptValue(key: string): string {
	return crypto
		.createHash('sha1')
		.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
		.digest('base64');
}

function handleWebSocketFrames(data: Buffer, socket: Socket): void {
	const fin = data[0] & 0x80;
	const opcode = data[0] & 0x0f;

	const mask = data[1] & 0x80;
	let payloadLength = data[1] & 0x7f;

	let offset = 2;

	if (payloadLength === 126) {
		payloadLength = data.readUInt16BE(offset);
		offset += 2;
	} else if (payloadLength === 127) {
		payloadLength = Number(data.readBigUInt64BE(offset));
		offset += 8;
	}

	const maskingKey = mask ? data.slice(offset, offset + 4) : null;
	offset += mask ? 4 : 0;

	let payloadData = data.slice(offset, offset + payloadLength);

	if (maskingKey) {
		payloadData = Buffer.from(payloadData.map((byte, idx) => byte ^ maskingKey[idx % 4]));
	}

	switch (opcode) {
		case 0x1: // Text frame
			const message = payloadData.toString('utf-8');
			console.log('Received message:', message);
			sendWebSocketFrame(socket, message);
			break;
		case 0x8: // Close frame
			console.log('Received close frame');
			socket.end();
			break;
		default:
			console.log('Received unsupported frame:', opcode);
			break;
	}
}

function sendWebSocketFrame(socket: Socket, message: string): void {
	const payload = Buffer.from(message, 'utf-8');
	const frame = Buffer.alloc(2 + payload.length);

	frame[0] = 0x81; // FIN and opcode for text frame
	frame[1] = payload.length; // Payload length
	payload.copy(frame, 2);

	socket.write(frame);
}

function isWebSocketHandshake(data: Buffer): boolean {
	return data.toString().includes('Sec-WebSocket-Key');
}

function isWebSocketFrame(data: Buffer): boolean {
	return (data[0] & 0x80) === 0x80 && (data[0] & 0x0f) !== 0x00;
}

function handleSseRequest(socket: Socket): void {
	const headers =
		'HTTP/1.1 200 OK\r\n' + 'Content-Type: text/event-stream\r\n' + 'Cache-Control: no-cache\r\n' + 'Connection: keep-alive\r\n' + 'Access-Control-Allow-Origin: *\r\n\r\n'; // Add CORS header
	socket.write(headers);
	sseClients.add(socket);
	console.log('SSE client connected');
}

type SseMessage = {
	event?: string;
	data?: string;
	id?: string;
	retry?: string;
};

function formatSseMessage(message: SseMessage): string {
	let formattedMessage = '';

	if (message.event) {
		formattedMessage += `event: ${message.event}\n`;
	}
	if (message.data) {
		formattedMessage += `data: ${message.data}\n`;
	}
	if (message.id) {
		formattedMessage += `id: ${message.id}\n`;
	}
	if (message.retry) {
		formattedMessage += `retry: ${message.retry}\n`;
	}

	formattedMessage += '\n';
	return formattedMessage;
}

function sendSseMessage(message: SseMessage): void {
	const formattedMessage = formatSseMessage(message);

	sseClients.forEach((client) => {
		client.write(formattedMessage);
	});
}
