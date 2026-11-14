package com.quizmaster.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * QuizMaster Android Main Activity
 *
 * This is the main entry point for the Android APK.
 * Handles WebView initialization and app navigation.
 */

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Set up app theme and status bar
        setStatusBarColor(Color.White)
        setNavigationBarColor(Color.Transparent)

        setContent {
            QuizMasterApp()
        }
    }
}

/**
 * Main QuizMaster App UI
 */
@Composable
fun QuizMasterApp() {
    val colorScheme = materialColorScheme()

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        content = { innerPadding ->
            Column(
                modifier = Modifier
                    .padding(innerPadding)
                    .fillMaxWidth()
                    .padding(bottom = 48.dp)
            ) {
                // Header
                Text(
                    text = "QuizMaster",
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp)
                )

                Spacer(Modifier.height(8.dp))

                // Connection status
                Text(
                    text = "Live AI Trivia",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp)
                )

                Spacer(Modifier.weight(1f))

                // Main content
                Text(
                    text = "AI-Powered Trivia Game",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp)
                )

                Spacer(Modifier.height(16.dp))

                // Placeholder for WebView content
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(500.dp)
                        .padding(16.dp)
                ) {
                    Text(
                        text = "WebView Content Loaded",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Gray800
                    )
                }
            }
        }
    )
}
