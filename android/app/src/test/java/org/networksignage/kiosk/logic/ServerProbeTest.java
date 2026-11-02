package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** Uses real sockets on loopback, so nothing leaves this computer. */
public class ServerProbeTest {
    private ServerSocket listener;
    private volatile String requestLine;

    private ServerAddress serve(String response) throws IOException {
        listener = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
        Thread thread = new Thread(() -> {
            try {
                while (true) {
                    try (Socket socket = listener.accept()) {
                        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        requestLine = in.readLine();
                        String line;
                        while ((line = in.readLine()) != null && !line.isEmpty()) { /* the headers */ }
                        OutputStream out = socket.getOutputStream();
                        out.write(response.getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                }
            } catch (IOException e) {
                // The listener closed, so the test is over.
            }
        });
        thread.setDaemon(true);
        thread.start();
        return ServerAddress.parse("http://127.0.0.1:" + listener.getLocalPort());
    }

    @After
    public void close() throws IOException {
        if (listener != null) listener.close();
    }

    @Test
    public void aServerThatAnswersCounts() throws IOException {
        ServerAddress address = serve("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assertTrue(ServerProbe.responds(address, 2000));
        assertEquals("GET /tv HTTP/1.1", requestLine);
    }

    @Test
    public void somethingElseOnThatPortDoesNot() throws IOException {
        assertFalse(ServerProbe.responds(serve("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), 2000));
    }

    @Test
    public void aRedirectDoesNot() throws IOException {
        assertFalse(ServerProbe.responds(serve("HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), 2000));
    }

    @Test
    public void nothingListeningDoesNot() throws IOException {
        ServerSocket closed = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        int port = closed.getLocalPort();
        closed.close();
        assertFalse(ServerProbe.responds(ServerAddress.parse("http://127.0.0.1:" + port), 2000));
    }

    @Test
    public void aSilentAddressGivesUpInTime() throws IOException {
        listener = new ServerSocket(0, 5, InetAddress.getLoopbackAddress()); // Accepts in the backlog, but never replies.
        long start = System.nanoTime();
        assertFalse(ServerProbe.responds(ServerAddress.parse("http://127.0.0.1:" + listener.getLocalPort()), 300));
        assertTrue((System.nanoTime() - start) / 1000000 < 3000);
    }
}
